import { streamText, tool } from "ai"
import { createMistral } from "@ai-sdk/mistral"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { z } from "zod"
import { PublicKey, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token"
import {
  getConnection,
  getBlockSummary,
  MAX_TX_VERSION,
  NATIVE_SYMBOL,
  EXPLORER_URL,
  CLUSTER,
  explorerTx,
  explorerAddress,
  SOLANA_TOKENS,
  NATIVE_SENTINEL,
  findToken,
  isNativeToken,
  isValidAddress,
} from "@/lib/solana"
import {
  keypairFromSecret,
  getMintInfo,
  buildSolTransfer,
  buildTokenTransfer,
  buildCreateToken,
  buildMintTo,
  serializeTx,
} from "@/lib/spl"
import { spotPriceUSD, dailyCandles, indicativeCandles } from "@/lib/prices"
import { uploadJSONToIPFS, isPinataConfigured, ipfsCid, gatewayUrl } from "@/lib/pinata"
import { IMAGE_FORMATS_LABEL } from "@/lib/images"
import { explainTarget } from "@/lib/explain"
import {
  insertSchedule,
  listSchedulesByOwner,
  cancelSchedule as dbCancelSchedule,
  listPaymentLinksByOwner,
  getContact,
  saveContact,
  listContacts,
  deleteContact,
  cleanContactName,
  addAsset,
  listAssets,
} from "@/lib/db"
import { createPaymentLink as createPaymentLinkRecord, paymentLinkPath, paymentLinkUrl, verifyPaymentLink } from "@/lib/payment-links"
import { requestOrigin } from "@/lib/origin"
import { isOwner, NOT_OWNER } from "@/lib/auth"
import { NextRequest, after } from "next/server"
import { maybeRunDueSchedules } from "@/lib/scheduler"
import { POST as generateImage } from "@/app/api/generate-image/route"
import { encryptSecret } from "@/lib/crypto"

export const runtime = "nodejs"
export const maxDuration = 60


// ── Model selection: Mistral first, Google Gemini as fallback ───────────────────
function getModel() {
  if (process.env.MISTRAL_API_KEY) {
    const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY })
    return mistral(process.env.ASTRAX_MODEL || "ministral-8b-latest")
  }
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (key) {
    const google = createGoogleGenerativeAI({ apiKey: key })
    return google(process.env.ASTRAX_MODEL || "gemini-2.0-flash")
  }
  return null
}

const connection = getConnection()

function makeWallet(secretKey?: string) {
  if (!secretKey) return null
  try {
    const keypair = keypairFromSecret(secretKey)
    return { keypair, publicKey: keypair.publicKey.toBase58() }
  } catch {
    return null
  }
}

// Map a recurrence word/phrase to an interval in seconds (0 = one-shot).
function parseEvery(every?: string): number {
  if (!every) return 0
  const s = every.trim().toLowerCase()
  if (/(^|\b)(once|one[-\s]?time|no)\b/.test(s)) return 0
  if (s.includes("hour")) return 3600
  if (s.includes("day") || s.includes("daily")) return 86400
  if (s.includes("week")) return 604800
  if (s.includes("month")) return 2592000 // ~30 days
  if (s.includes("year")) return 31536000
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month)/)
  if (m) {
    const n = parseInt(m[1], 10)
    const unit = m[2]
    const base = unit === "second" ? 1 : unit === "minute" ? 60 : unit === "hour" ? 3600 : unit === "day" ? 86400 : unit === "week" ? 604800 : 2592000
    return n * base
  }
  return 0
}

function parseWhen(when: string): Date | null {
  const now = new Date()
  const s = when.trim().toLowerCase()
  const rel = s.match(/in\s+(\d+)\s*(min|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const d = new Date(now)
    if (unit.startsWith("min")) d.setMinutes(d.getMinutes() + n)
    else if (unit.startsWith("h")) d.setHours(d.getHours() + n)
    else if (unit.startsWith("day")) d.setDate(d.getDate() + n)
    else if (unit.startsWith("week")) d.setDate(d.getDate() + n * 7)
    return d
  }
  if (s.includes("tomorrow") || s.includes("today")) {
    const d = new Date(now)
    if (s.includes("tomorrow")) d.setDate(d.getDate() + 1)
    const t = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
    if (t) {
      let h = parseInt(t[1], 10)
      const m = t[2] ? parseInt(t[2], 10) : 0
      if (t[3] === "pm" && h < 12) h += 12
      if (t[3] === "am" && h === 12) h = 0
      d.setHours(h, m, 0, 0)
    }
    return d
  }
  const parsed = new Date(when)
  return isNaN(parsed.getTime()) ? null : parsed
}

async function nativeUsdPrice(): Promise<number | null> {
  const spot = await spotPriceUSD("SOL")
  if (spot != null) return spot
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      headers: { accept: "application/json" },
    })
    if (!res.ok) return null
    const j = await res.json()
    return j?.solana?.usd ?? null
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `You are **Astrax**, the AI agent built into the Astrax dApp — a natural-language command center for **Solana** (cluster: ${CLUSTER}, native token **${NATIVE_SYMBOL}**, explorer ${EXPLORER_URL}).

## Personality
You talk only about Astrax, the Solana blockchain, and crypto operations. If asked about something unrelated, give a short warm redirect back to what Astrax can do.

## CRITICAL BEHAVIOR — act, don't explain
When the user asks for an on-chain action, call the matching tool immediately, then summarise the result in one or two short sentences. The UI renders a rich card (and, in wallet mode, a one-click confirm button) from the tool result, so keep your text brief.

Guidance:
- balance → getBalance ; token balance → getTokenBalance
- "send 1 ${NATIVE_SYMBOL} to <address>/alice" → sendPayment (token defaults to native ${NATIVE_SYMBOL})
- "look up tx <signature>" → getTransaction ; "latest blocks" → getLatestBlocks ; "block 123" → getBlock
- "list tokens" → listTokens ; "price/market" → getMarketData ; "activity for <address>" → getAddressActivity
- "what is this <address/signature> / is this safe / what does this program do / explain this tx" → explain
- "price chart / candlestick / chart for ${NATIVE_SYMBOL}" → getPriceChart
- "diagram / workflow / flowchart / visualize this" → generateDiagram (YOU write the Mermaid code)
- "generate an image of … / draw …" → generateImage
- Users can attach images (PNG, JPG, GIF, WebP); you'll see a note with their IPFS links. For an NFT, call deployNFT and leave "image" empty: the attached image is used automatically. Never invent an image URL or placeholder. If there's no image, deployNFT tells the user to attach one. To keep an image without minting, use storeAsset.
- If the user attaches an image and asks for an NFT but gives no name, ask for a name (and symbol) first.
- "create token MoonCoin MOON supply 1000000" → deployToken (creates an SPL token with on-chain name/symbol)
- "create an NFT / mint an NFT" → deployNFT (a 1-of-1 SPL token with fixed supply)
- "mint 500 more <mint>" → mintTokens (only works if the user is the mint authority)
- Arbitrary smart-contract / program deployment is NOT supported from chat — say so briefly and offer token/NFT creation instead.
- "schedule 2 ${NATIVE_SYMBOL} to alice tomorrow at 5pm" → scheduleTransfer (one-time)
- "pay alice 500 ${NATIVE_SYMBOL} every month for a year / salary" → scheduleTransfer with every:"monthly", occurrences:12
- "show my scheduled payments" → listSchedules ; "cancel schedule <id>" → cancelSchedule
- "payment link for 0.5 ${NATIVE_SYMBOL}" → createPaymentLink ; "my payment links / has my link been paid" → listPaymentLinks
- "save alice as <address>" → saveContact ; "who is alice" → resolveContact ; "my contacts" → listContacts ; "remove alice" → deleteContact
- Recipients can be a contact name ("send 1 SOL to alice") — pass the name itself as the recipient.
- "store asset <link>" → storeAsset ; "my assets" → listAssets

## Formatting
- **bold** for key terms, backticks for addresses/signatures. Keep it to one or two sentences. Never invent signatures, addresses, or balances — only report tool output.
- Do NOT add notes, footnotes, caveats, unit conversions or mentions of pages/features that aren't in the tool result.
- If a tool returns an error, repeat its reason in your own short sentence. Never guess at other causes, amounts or commands.
- Never retype full addresses, mints, signatures or URLs/links in your text — the card below shows them exactly. Say "the recipient", "the link below", a contact name, or the token symbol instead.
- Don't restate what the card already lists (each item's amount, status, date, link). Give a one-sentence summary instead, e.g. "You have 1 payment link — it's been paid."
- Plain markdown only — never output HTML or JSX-style tags.`

// Turn raw web3.js / RPC errors into a plain, accurate reason so the model
// doesn't have to guess (it otherwise invents causes).
function friendlyError(e: any): string {
  const msg = String(e?.message || e || "unknown error")
  const logs = Array.isArray(e?.logs) ? e.logs.join(" ") : ""
  const all = `${msg} ${logs}`
  if (/no record of a prior credit|AccountNotFound/i.test(all))
    return `Your signing wallet has no SOL on ${CLUSTER} yet, so it can't pay the amount or the network fee. Fund it first${CLUSTER === "devnet" ? " (for example from faucet.solana.com)" : ""}.`
  if (/insufficient lamports|insufficient funds for rent|InsufficientFundsForRent/i.test(all))
    return "Not enough SOL in your signing wallet to cover the amount plus fees."
  if (/insufficient funds/i.test(all) || /custom program error: 0x1\b/i.test(all))
    return "Not enough tokens in your signing wallet for this transfer."
  if (/owner does not match|custom program error: 0x4\b/i.test(all))
    return "Your wallet isn't the authority for this token, so it can't do that."
  if (/Blockhash not found|block height exceeded|expired/i.test(all))
    return "The network didn't confirm it in time. Nothing was sent; try again."
  if (/429|Too Many Requests/i.test(all)) return "The Solana RPC is rate-limiting requests right now. Try again in a moment."
  return msg.slice(0, 160)
}

// Only the ACTIVE signing mode is described, so the model never hedges between modes.
function signingSection(mode: "auto" | "wallet", hasSigner: boolean): string {
  if (mode === "wallet") {
    return `## Signing (current mode: WALLET)
The user approves every transaction in their own wallet. Write tools (sendPayment, deployToken, deployNFT, mintTokens) only PREPARE a transaction; the chat then shows a confirm button under your reply.
- ONLY when one of those write tools just returned a prepared transaction: say what is ready (amount, recipient, token) and tell them to click the button below to confirm in their wallet.
- For every other reply (balances, prices, blocks, explain, contacts, links, errors…) never mention buttons, confirming, wallets or connecting.
- The app renders the button itself. Never write a button, tag, placeholder or any markup for it (no "<ConfirmButton>", no "[Confirm]").
- Nothing is on-chain yet: never say it was sent, created or minted.
- Do not mention autonomous mode, secret keys or signing setup unless a tool returned an error about it.
${hasSigner ? "" : "- No wallet is connected. Only if a write tool returns a no-wallet error, tell them to connect their wallet in the top bar."}`
  }
  return `## Signing (current mode: AUTONOMOUS)
Astrax signs and submits transactions immediately with the user's key. There is NO confirm button and no wallet popup.
- After a write tool succeeds, report that it was done and give the signature from the tool result.
- Never tell the user to click a button or confirm in a wallet. Do not mention wallet mode.
${hasSigner ? "" : "- No secret key is loaded. Only if a write tool returns a no-key error, tell them to paste one in the sidebar **Signing** panel."}`
}

export async function POST(req: Request) {
  // Chat traffic doubles as a scheduler heartbeat (runs after the response).
  after(() => maybeRunDueSchedules())
  // The domain this request came in on (localhost, preview, production…).
  const origin = requestOrigin(req)
  const body = await req.json()
  const messages = body.messages ?? []
  const signingMode: "auto" | "wallet" = body.signingMode === "auto" ? "auto" : "wallet"
  const credentials = body.credentials ?? {}
  const privateKey: string | undefined = credentials.privateKey || undefined
  const walletAddress: string | undefined =
    body.walletAddress && isValidAddress(body.walletAddress) ? body.walletAddress : undefined

  // ── NFT images ───────────────────────────────────────────────────────────────
  // The chat UI sends which images each user message carried. Only IPFS links (from
  // our uploader) count, so the NFT gets the real upload, never a URL or placeholder
  // the model made up.
  type Attached = { url: string; contentType?: string }
  const rawAttachments: Record<string, unknown> =
    body.attachments && typeof body.attachments === "object" && !Array.isArray(body.attachments) ? body.attachments : {}
  const attachedFor = (id: string): Attached[] => {
    const list = rawAttachments[id]
    if (!Array.isArray(list)) return []
    return list.slice(0, 8).flatMap((a: any) => {
      const cid = typeof a?.url === "string" ? ipfsCid(a.url) : null
      if (!cid) return []
      const ct = typeof a.contentType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(a.contentType) ? a.contentType : undefined
      return [{ url: gatewayUrl(cid), contentType: ct }]
    })
  }
  const allAttached: Attached[] = []
  // Images attached since the last NFT was created, so a new NFT doesn't reuse an old image.
  let freshAttached: Attached[] = []
  for (const m of messages) {
    if (m?.role === "user") {
      const a = attachedFor(String(m.id))
      allAttached.push(...a)
      freshAttached.push(...a)
    } else if (
      m?.role === "assistant" &&
      Array.isArray(m.toolInvocations) &&
      m.toolInvocations.some((t: any) => t?.toolName === "deployNFT" && t?.state === "result" && !t?.result?.error)
    ) {
      freshAttached = []
    }
  }
  const userText = messages.filter((m: any) => m?.role === "user").map((m: any) => String(m.content || "")).join("\n")
  const resolveNftImage = (arg?: string): Attached | null => {
    const cid = arg ? ipfsCid(arg) : null
    if (cid) {
      // One of the attached images (e.g. the user picked between several)…
      const known = allAttached.find((x) => ipfsCid(x.url) === cid)
      if (known) return known
      // …or an IPFS link the user pasted themselves.
      if (userText.includes(cid)) return { url: gatewayUrl(cid) }
    }
    return freshAttached.length > 0 ? freshAttached[freshAttached.length - 1] : null
  }

  const model = getModel()
  if (!model) {
    return new Response(
      JSON.stringify({ error: "No AI model configured. Set MISTRAL_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY." }),
      { status: 500, headers: { "content-type": "application/json" } },
    )
  }

  const wallet = signingMode === "auto" ? makeWallet(privateKey) : null
  const ownerAddress = signingMode === "auto" ? wallet?.publicKey : walletAddress
  // `walletAddress` is only a claim from the browser. Owner-only data (schedules,
  // payment links, assets) needs proof: the secret key itself (autonomous), or a
  // verified wallet session cookie (wallet mode).
  const verifiedOwner = signingMode === "auto" ? wallet?.publicKey : isOwner(req, walletAddress) ? walletAddress : undefined
  const needOwner = () => (ownerAddress ? NOT_OWNER : { error: "No wallet address available." })

  // Guard for write tools: either a server wallet (auto) or a connected address (wallet).
  const noSigner = () =>
    signingMode === "auto"
      ? { error: "No secret key configured. Open the sidebar **Signing** panel, switch to **Autonomous**, and paste your secret key." }
      : { error: "No wallet connected. Connect your wallet in the top bar (wallet signing mode) and try again." }

  // Resolve a recipient (address, or a name from THIS user's contacts) to an address.
  // Contact lookup needs a verified owner, so nobody can read someone else's contacts.
  const resolveRecipient = async (to: string): Promise<{ address: string } | { error: string; needsAuth?: boolean }> => {
    if (isValidAddress(to)) return { address: to }
    if (!verifiedOwner) return ownerAddress ? NOT_OWNER : { error: `"${to}" isn't an address. Connect a wallet to use saved contacts.` }
    const c = await getContact(verifiedOwner, to)
    if (c && isValidAddress(c.address)) return { address: c.address }
    return { error: `No contact named "${cleanContactName(to)}". Give an address or save them as a contact first.` }
  }

  // Resolve a token argument (symbol or mint address) to its mint, program and decimals.
  type ResolvedToken = { mint: PublicKey; programId: PublicKey; decimals: number; symbol: string }
  const resolveToken = async (token: string): Promise<ResolvedToken | { error: string }> => {
    const info = findToken(token)
    const mintStr = info?.address && info.address !== NATIVE_SENTINEL ? info.address : token
    if (!isValidAddress(mintStr)) return { error: `Unknown token: ${token}` }
    const mint = new PublicKey(mintStr)
    try {
      const { programId, decimals } = await getMintInfo(connection, mint)
      return { mint, programId, decimals, symbol: info?.symbol ?? (mintStr === token ? `${token.slice(0, 4)}…` : token) }
    } catch (e: any) {
      return { error: `Could not read mint ${token}: ${e?.message || "not found"}.` }
    }
  }

  const result = await streamText({
    model,
    system: `${SYSTEM_PROMPT}\n\n${signingSection(signingMode, Boolean(ownerAddress))}`,
    messages,
    maxSteps: 6,
    tools: {
      // ── READ ──────────────────────────────────────────────────────────────
      getBalance: tool({
        description: `Get the native ${NATIVE_SYMBOL} balance of an address. If no address is given, uses the user's own address.`,
        parameters: z.object({ address: z.string().optional() }),
        execute: async ({ address }) => {
          try {
            const target = address && isValidAddress(address) ? address : ownerAddress
            if (!target || !isValidAddress(target)) return { error: "No valid address available." }
            const lamports = await connection.getBalance(new PublicKey(target))
            const balance = lamports / LAMPORTS_PER_SOL
            const price = await nativeUsdPrice()
            return {
              kind: "balance",
              address: target,
              balance: balance.toFixed(4),
              symbol: NATIVE_SYMBOL,
              usdValue: price ? (balance * price).toFixed(2) : undefined,
            }
          } catch {
            return { error: "Failed to fetch balance." }
          }
        },
      }),

      getTokenBalance: tool({
        description: "Get an SPL token balance for an address. Accepts a token symbol (e.g. USDC) or mint address.",
        parameters: z.object({ token: z.string(), address: z.string().optional() }),
        execute: async ({ token, address }) => {
          try {
            const target = address && isValidAddress(address) ? address : ownerAddress
            if (!target || !isValidAddress(target)) return { error: "No valid address available." }
            const resolved = await resolveToken(token)
            if ("error" in resolved) return resolved
            const ata = getAssociatedTokenAddressSync(resolved.mint, new PublicKey(target), true, resolved.programId)
            try {
              const acc = await getAccount(connection, ata, "confirmed", resolved.programId)
              const balance = Number(acc.amount) / 10 ** resolved.decimals
              return { kind: "balance", address: target, balance: balance.toFixed(4), symbol: resolved.symbol }
            } catch {
              return { kind: "balance", address: target, balance: "0.0000", symbol: resolved.symbol }
            }
          } catch {
            return { error: "Failed to fetch token balance." }
          }
        },
      }),

      getTransaction: tool({
        description: "Look up details of a transaction by its signature.",
        parameters: z.object({ hash: z.string() }),
        execute: async ({ hash }) => {
          try {
            const tx = await connection.getParsedTransaction(hash, { maxSupportedTransactionVersion: MAX_TX_VERSION })
            if (!tx) return { error: "Transaction not found." }
            const keys = tx.transaction.message.accountKeys
            const from = keys[0]?.pubkey.toBase58()
            const to = keys[1]?.pubkey.toBase58()
            const pre = tx.meta?.preBalances?.[0] ?? 0
            const post = tx.meta?.postBalances?.[0] ?? 0
            const feeLamports = tx.meta?.fee ?? 0
            // SOL the fee payer spent beyond the network fee (transfers, rent, …).
            const moved = Math.max(0, pre - post - feeLamports) / LAMPORTS_PER_SOL
            return {
              kind: "transaction",
              hash,
              from,
              to,
              value: `${moved.toFixed(6)} ${NATIVE_SYMBOL}`,
              blockNumber: tx.slot?.toString() ?? "pending",
              status: tx.meta?.err ? "Failed" : "Success",
              fee: `${(feeLamports / LAMPORTS_PER_SOL).toFixed(6)} ${NATIVE_SYMBOL}`,
              explorerUrl: explorerTx(hash),
            }
          } catch {
            return { error: "Transaction not found." }
          }
        },
      }),

      getLatestBlocks: tool({
        description: "Get the most recent blocks (slots) on Solana.",
        parameters: z.object({ count: z.number().int().min(1).max(5).optional() }),
        execute: async ({ count }) => {
          try {
            const n = count ?? 3
            // Use the confirmed tip; the processed tip often isn't queryable yet.
            const slot = await connection.getSlot("confirmed")
            const blocks: any[] = []
            for (let s = slot; blocks.length < n && s > slot - 20 && s >= 0; s--) {
              const b = await getBlockSummary(s).catch(() => null) // null = skipped slot
              if (b) {
                blocks.push({
                  blockNumber: s.toString(),
                  hash: b.blockhash,
                  timestamp: b.blockTime ? new Date(b.blockTime * 1000).toLocaleString() : "",
                  transactionCount: b.transactionCount,
                })
              }
            }
            if (blocks.length === 0) return { error: "Could not read recent blocks from the RPC." }
            return { kind: "blocks", blocks }
          } catch {
            return { error: "Failed to fetch blocks." }
          }
        },
      }),

      getBlock: tool({
        description: "Get a block by slot number.",
        parameters: z.object({ block: z.string() }),
        execute: async ({ block }) => {
          try {
            const slot = parseInt(block, 10)
            if (isNaN(slot)) return { error: "Give a numeric slot." }
            const b = await getBlockSummary(slot)
            if (!b) return { error: `No block at slot ${slot} (it may have been skipped or pruned).` }
            return {
              kind: "block",
              blockNumber: slot.toString(),
              hash: b.blockhash,
              timestamp: b.blockTime ? new Date(b.blockTime * 1000).toLocaleString() : "",
              transactionCount: b.transactionCount,
              parentSlot: b.parentSlot.toString(),
            }
          } catch {
            return { error: "Block not found." }
          }
        },
      }),

      listTokens: tool({
        description: "List the tokens supported/known on Solana.",
        parameters: z.object({}),
        execute: async () => ({ kind: "tokenList", tokens: SOLANA_TOKENS }),
      }),

      explain: tool({
        description:
          "Explain / audit a transaction signature OR an address/program: decode what it does, label the account type, and flag risks. Use whenever the user pastes a signature or address, or asks 'what is this', 'is this safe', 'what does this do'.",
        parameters: z.object({ target: z.string().describe("A transaction signature or an account address") }),
        execute: async ({ target }) => {
          return await explainTarget(target)
        },
      }),

      getMarketData: tool({
        description: `Get market data (price, market cap, volume) for Solana / ${NATIVE_SYMBOL}.`,
        parameters: z.object({}),
        execute: async () => {
          const price = await nativeUsdPrice()
          let marketCap: number | null = null
          let volume24h: number | null = null
          let change24h: number | null = null
          let name = "Solana"
          try {
            const res = await fetch(
              "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false",
              { headers: { accept: "application/json" } },
            )
            if (res.ok) {
              const j = await res.json()
              name = j.name || name
              marketCap = j.market_data?.market_cap?.usd ?? null
              volume24h = j.market_data?.total_volume?.usd ?? null
              change24h = j.market_data?.price_change_percentage_24h ?? null
            }
          } catch {
            /* best-effort */
          }
          if (price == null && marketCap == null) return { error: "Market data unavailable right now." }
          return { kind: "market", name, symbol: NATIVE_SYMBOL, price, marketCap, volume24h, change24h }
        },
      }),

      getAddressActivity: tool({
        description: "Get recent transactions for an address on Solana.",
        parameters: z.object({ address: z.string().optional() }),
        execute: async ({ address }) => {
          const target = address && isValidAddress(address) ? address : ownerAddress
          if (!target || !isValidAddress(target)) return { error: "No valid address available." }
          try {
            const sigs = await connection.getSignaturesForAddress(new PublicKey(target), { limit: 8 })
            const transactions = sigs.map((s) => ({
              hash: s.signature,
              from: target,
              to: "",
              value: "",
              status: s.err ? "Failed" : "Success",
              timestamp: s.blockTime ? new Date(s.blockTime * 1000).toLocaleString() : "",
            }))
            return {
              kind: "activity",
              address: target,
              transactions,
              explorerUrl: explorerAddress(target),
            }
          } catch {
            return { kind: "activity", address: target, transactions: [], note: "Could not load activity.", explorerUrl: explorerAddress(target) }
          }
        },
      }),

      resolveContact: tool({
        description: "Look up one of the user's saved contacts by name.",
        parameters: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          if (!verifiedOwner) return needOwner()
          const c = await getContact(verifiedOwner, name)
          return c ? { kind: "contact", name: c.name, address: c.address } : { error: `No contact named "${cleanContactName(name)}".` }
        },
      }),

      saveContact: tool({
        description: "Save (or update) a contact name → address in the user's own address book.",
        parameters: z.object({ name: z.string(), address: z.string() }),
        execute: async ({ name, address }) => {
          if (!verifiedOwner) return needOwner()
          if (!isValidAddress(address)) return { error: "That is not a valid Solana address." }
          if (!cleanContactName(name)) return { error: "Give the contact a name." }
          const c = await saveContact(verifiedOwner, name, address)
          return { kind: "contact", name: c.name, address: c.address, saved: true }
        },
      }),

      listContacts: tool({
        description: "List the user's saved contacts.",
        parameters: z.object({}),
        execute: async () => {
          if (!verifiedOwner) return needOwner()
          return { kind: "contactList", contacts: await listContacts(verifiedOwner) }
        },
      }),

      deleteContact: tool({
        description: "Remove a contact from the user's address book by name.",
        parameters: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          if (!verifiedOwner) return needOwner()
          const ok = await deleteContact(verifiedOwner, name)
          return ok ? { kind: "contactDeleted", name: cleanContactName(name) } : { error: `No contact named "${cleanContactName(name)}".` }
        },
      }),

      // ── WRITE (auto = sign now; wallet = return a prepared transaction) ───────
      sendPayment: tool({
        description: `Send ${NATIVE_SYMBOL} (native) or an SPL token to an address or saved contact.`,
        parameters: z.object({
          to: z.string(),
          amount: z.string(),
          token: z.string().optional(),
        }),
        execute: async ({ to, amount, token }) => {
          const resolved = await resolveRecipient(to)
          if ("error" in resolved) return resolved
          const recipient = resolved.address
          const native = isNativeToken(token)
          let spl: ResolvedToken | undefined
          if (!native) {
            const resolved = await resolveToken(token!)
            if ("error" in resolved) return resolved
            spl = resolved
          }
          const symbol = spl?.symbol ?? NATIVE_SYMBOL
          const build = (owner: PublicKey) =>
            spl
              ? buildTokenTransfer(connection, owner, new PublicKey(recipient), spl.mint, amount, spl.decimals, spl.programId)
              : buildSolTransfer(connection, owner, new PublicKey(recipient), amount)

          if (signingMode === "wallet") {
            if (!ownerAddress) return noSigner()
            try {
              const tx = await build(new PublicKey(ownerAddress))
              return {
                kind: "action",
                action: native ? "sendNative" : "sendToken",
                to: recipient,
                amount,
                symbol,
                txBase64: serializeTx(tx),
                label: `Send ${amount} ${symbol}`,
              }
            } catch (e: any) {
              return { error: `Could not prepare transfer: ${(e?.message || "unknown error").slice(0, 160)}` }
            }
          }

          // autonomous
          if (!wallet) return noSigner()
          try {
            const owner = wallet.keypair.publicKey
            const tx = await build(owner)
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair])
            return { kind: "transaction", status: "Submitted", action: "send", hash: sig, from: owner.toBase58(), to: recipient, value: `${amount} ${symbol}`, explorerUrl: explorerTx(sig) }
          } catch (e: any) {
            return { error: `Payment not sent: ${friendlyError(e)}` }
          }
        },
      }),

      deployToken: tool({
        description: "Create a new SPL token on Solana with on-chain name/symbol metadata. Mints the full supply to the creator.",
        parameters: z.object({
          name: z.string(),
          symbol: z.string(),
          supply: z.string().describe("Whole-token supply, e.g. 1000000"),
          decimals: z.number().int().min(0).max(9).optional().describe("Defaults to 9"),
        }),
        execute: async ({ name, symbol, supply, decimals }) => {
          const params = { name, symbol, decimals: decimals ?? 9, supply, uri: "" }
          if (!/^\d+(\.\d+)?$/.test(supply)) return { error: `Invalid supply "${supply}".` }
          if (signingMode === "wallet") {
            if (!ownerAddress) return noSigner()
            // The mint keypair is generated in the browser so it can co-sign.
            return { kind: "action", action: "deployToken", ...params, label: `Create token ${name} (${symbol})` }
          }
          if (!wallet) return noSigner()
          try {
            const { tx, mint } = await buildCreateToken(connection, wallet.keypair.publicKey, params)
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair, mint])
            return { kind: "deploy", what: "token", name, symbol, supply, contractAddress: mint.publicKey.toBase58(), hash: sig, explorerUrl: explorerTx(sig) }
          } catch (e: any) {
            return { error: `Create failed: ${friendlyError(e)}` }
          }
        },
      }),

      deployNFT: tool({
        description:
          "Create a 1-of-1 NFT on Solana (SPL token, 0 decimals, supply 1, mint authority revoked) with on-chain name/symbol and IPFS metadata. An NFT needs an image the user attached with the paperclip; the attached image is used automatically, so leave `image` empty. Never make up an image URL or placeholder. Use for 'create an NFT' / 'mint an NFT'.",
        parameters: z.object({
          name: z.string(),
          symbol: z.string(),
          image: z.string().optional().describe("Leave empty: the user's attached image is used. Only set it to an IPFS URL from the conversation when the user picks one of several images."),
          description: z.string().optional(),
        }),
        execute: async ({ name, symbol, image, description }) => {
          const picked = resolveNftImage(image)
          if (!picked) {
            return {
              error: `An NFT needs an image. Attach one with the paperclip button (${IMAGE_FORMATS_LABEL}, up to 10 MB), wait until it shows "Uploaded to IPFS", then ask again.`,
            }
          }
          if (!isPinataConfigured()) return { error: "NFT metadata can't be stored because IPFS isn't configured on this server." }

          // Standard (Metaplex-style) metadata JSON that wallets and explorers read.
          let metadataUri: string
          try {
            const meta = {
              name,
              symbol,
              description: description || name,
              image: picked.url,
              properties: { category: "image", files: [{ uri: picked.url, ...(picked.contentType ? { type: picked.contentType } : {}) }] },
            }
            metadataUri = (await uploadJSONToIPFS(meta, `${symbol || "nft"}-metadata.json`)).ipfsUrl
          } catch {
            return { error: "Couldn't save the NFT metadata to IPFS, so nothing was created. Try again." }
          }
          const imageUsed = picked.url

          const params = { name, symbol, decimals: 0, supply: "1", uri: metadataUri, fixedSupply: true }
          if (signingMode === "wallet") {
            if (!ownerAddress) return noSigner()
            return { kind: "action", action: "deployNFT", ...params, image: imageUsed, metadataUri, label: `Create NFT ${name} (${symbol})` }
          }
          if (!wallet) return noSigner()
          try {
            const { tx, mint } = await buildCreateToken(connection, wallet.keypair.publicKey, params)
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair, mint])
            return { kind: "deploy", what: "nft", name, symbol, image: imageUsed, metadataUri, contractAddress: mint.publicKey.toBase58(), hash: sig, explorerUrl: explorerTx(sig) }
          } catch (e: any) {
            return { error: `Create failed: ${friendlyError(e)}` }
          }
        },
      }),

      mintTokens: tool({
        description: "Mint additional units of an existing SPL token mint to a recipient. Give the mint address; mints to the user unless another address is specified. The user must be the mint authority (NFTs created by Astrax have a fixed supply and cannot be minted further).",
        parameters: z.object({ mint: z.string().describe("Mint address"), to: z.string().optional(), amount: z.string().optional() }),
        execute: async ({ mint: mintArg, to, amount }) => {
          if (!isValidAddress(mintArg)) return { error: "That is not a valid mint address." }
          const recipient = to && isValidAddress(to) ? to : ownerAddress
          if (!recipient || !isValidAddress(recipient)) return { error: "No recipient address available." }
          const mint = new PublicKey(mintArg)
          let info: { programId: PublicKey; decimals: number }
          try {
            info = await getMintInfo(connection, mint)
          } catch (e: any) {
            return { error: `Could not read that mint: ${e?.message || "not found"}.` }
          }
          const amt = amount || "1"
          if (signingMode === "wallet") {
            if (!ownerAddress) return noSigner()
            try {
              const tx = await buildMintTo(connection, new PublicKey(ownerAddress), mint, new PublicKey(recipient), amt, info.decimals, info.programId)
              return { kind: "action", action: "mintTokens", mint: mintArg, to: recipient, amount: amt, txBase64: serializeTx(tx), label: `Mint ${amt} → ${recipient.slice(0, 4)}…${recipient.slice(-4)}` }
            } catch (e: any) {
              return { error: `Could not prepare mint: ${(e?.message || "unknown error").slice(0, 160)}` }
            }
          }
          if (!wallet) return noSigner()
          try {
            const tx = await buildMintTo(connection, wallet.keypair.publicKey, mint, new PublicKey(recipient), amt, info.decimals, info.programId)
            const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair])
            return { kind: "transaction", status: "Submitted", action: "mint", hash: sig, to: recipient, value: `${amt} token(s)`, explorerUrl: explorerTx(sig) }
          } catch (e: any) {
            return { error: `Mint failed: ${friendlyError(e)}` }
          }
        },
      }),

      scheduleTransfer: tool({
        description: `Schedule a one-time or RECURRING transfer (e.g. salary). Requires Autonomous (secret key) signing mode. "when" accepts "in 10 minutes", "tomorrow at 5pm", or an ISO date. "every" makes it recurring: daily/weekly/monthly or "2 weeks"; "occurrences" is how many times (default 1 for one-time, or e.g. 12 for a year of monthly).`,
        parameters: z.object({
          to: z.string(),
          amount: z.string(),
          when: z.string().describe('First run time, e.g. "tomorrow 9am"'),
          token: z.string().optional(),
          every: z.string().optional().describe('Recurrence: daily / weekly / monthly / "2 weeks". Omit for one-time.'),
          occurrences: z.number().int().min(1).max(120).optional().describe("Number of runs (default 1)"),
        }),
        execute: async ({ to, amount, when, token, every, occurrences }) => {
          if (signingMode !== "auto" || !wallet) {
            return { error: "Scheduling needs **Autonomous** signing (a secret key) so Astrax can send it later without you present. Switch to Autonomous in the sidebar **Signing** panel." }
          }
          const runAt = parseWhen(when)
          if (!runAt) return { error: `Could not understand the time "${when}". Try "in 10 minutes" or "2026-01-01 17:00".` }
          const resolved = await resolveRecipient(to)
          if ("error" in resolved) return resolved
          const recipient = resolved.address
          if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return { error: `Invalid amount "${amount}".` }
          if (!isNativeToken(token)) {
            const resolved = await resolveToken(token!)
            if ("error" in resolved) return resolved
          }
          const intervalSecs = parseEvery(every)
          const remaining = occurrences ?? 1
          const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
          await insertSchedule({
            id,
            owner: wallet.publicKey,
            recipient,
            amount,
            token: token || "",
            next_run: runAt.getTime(),
            interval_secs: intervalSecs,
            remaining,
            enc_key: encryptSecret(privateKey as string),
          })
          const recurrenceLabel = intervalSecs ? `every ${every} × ${remaining}` : "once"
          return {
            kind: "schedule",
            id,
            to: recipient,
            amount: `${amount} ${token || NATIVE_SYMBOL}`,
            runAt: runAt.toLocaleString(),
            recurrence: recurrenceLabel,
            note: `Sent within about a minute of the time while Astrax is open anywhere, and within the hour otherwise. Your key is stored encrypted for this (${CLUSTER}).`,
          }
        },
      }),

      listSchedules: tool({
        description: "List the user's scheduled transfers (upcoming and past).",
        parameters: z.object({}),
        execute: async () => {
          const owner = verifiedOwner
          if (!owner) return needOwner()
          const rows = (await listSchedulesByOwner(owner)).map((r) => ({
            id: r.id,
            to: r.recipient,
            amount: `${r.amount} ${r.token || NATIVE_SYMBOL}`,
            runAt: new Date(r.next_run).toLocaleString(),
            recurrence: r.interval_secs ? `recurring (${r.remaining} left)` : "once",
            status: r.status,
            lastTx: r.last_tx || undefined,
          }))
          return { kind: "scheduleList", schedules: rows }
        },
      }),

      cancelSchedule: tool({
        description: "Cancel an active scheduled transfer by its id.",
        parameters: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          const owner = verifiedOwner
          if (!owner) return needOwner()
          const ok = await dbCancelSchedule(id, owner)
          return ok ? { kind: "scheduleCancelled", id } : { error: `No active schedule ${id} found for you.` }
        },
      }),

      createPaymentLink: tool({
        description: `Create a shareable payment link requesting ${NATIVE_SYMBOL} to the user's address. Astrax tracks it and marks it paid automatically once someone pays.`,
        parameters: z.object({ amount: z.string(), description: z.string().optional().describe("What the payment is for (shown to the payer)") }),
        execute: async ({ amount, description }) => {
          if (!ownerAddress || !isValidAddress(ownerAddress)) return { error: "No receiving address available. Connect a wallet or add a secret key." }
          if (!verifiedOwner) return NOT_OWNER
          if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return { error: `Invalid amount "${amount}".` }
          const link = await createPaymentLinkRecord({ owner: verifiedOwner, amount, description })
          return { kind: "paymentLink", id: link.id, path: paymentLinkPath(link.id), url: paymentLinkUrl(link.id, origin), address: verifiedOwner, amount: `${amount} ${NATIVE_SYMBOL}`, description: link.description || undefined, status: link.status }
        },
      }),

      listPaymentLinks: tool({
        description: "List the user's payment links and whether each has been paid.",
        parameters: z.object({}),
        execute: async () => {
          if (!verifiedOwner) return needOwner()
          const rows = await Promise.all(
            (await listPaymentLinksByOwner(verifiedOwner, 20)).map((r) => (r.status === "open" ? verifyPaymentLink(r) : r)),
          )
          return {
            kind: "paymentLinkList",
            links: rows.map((r) => ({
              id: r.id,
              path: paymentLinkPath(r.id),
              url: paymentLinkUrl(r.id, origin),
              amount: `${r.amount} ${r.token}`,
              description: r.description || undefined,
              status: r.status,
              createdAt: new Date(r.created_at).toLocaleString(),
            })),
          }
        },
      }),

      storeAsset: tool({
        description: "Store a reference to an asset (e.g. an IPFS link) with a description, owned by the user.",
        parameters: z.object({ link: z.string(), description: z.string() }),
        execute: async ({ link, description }) => {
          if (!verifiedOwner) return needOwner()
          await addAsset(verifiedOwner, link, description)
          return { kind: "asset", link, description, owner: verifiedOwner, saved: true }
        },
      }),

      listAssets: tool({
        description: "List the user's stored assets.",
        parameters: z.object({}),
        execute: async () => {
          if (!verifiedOwner) return needOwner()
          return { kind: "assetList", assets: await listAssets(verifiedOwner) }
        },
      }),

      // ── VISUALS / DATA ──────────────────────────────────────────────────────
      getPriceChart: tool({
        description: `Get an OHLC candlestick price chart for a token over a number of days. Defaults to ${NATIVE_SYMBOL}. Prices come from Coinbase.`,
        parameters: z.object({
          symbol: z.string().optional().describe(`Token symbol, e.g. ${NATIVE_SYMBOL}, USDC. Defaults to ${NATIVE_SYMBOL}.`),
          days: z.number().int().min(2).max(30).optional(),
        }),
        execute: async ({ symbol, days }) => {
          const sym = (symbol || NATIVE_SYMBOL).toUpperCase()
          const d = days ?? 7
          let data = await dailyCandles(sym, d)
          let indicative = false
          if (!data) {
            data = await indicativeCandles(sym, d)
            indicative = true
          }
          if (!data || data.length === 0) return { error: `No price data available for ${sym}.` }
          return { kind: "candlestick", symbol: sym, days: d, data, indicative }
        },
      }),

      generateDiagram: tool({
        description:
          "Render a flowchart / workflow diagram as an image. YOU write valid Mermaid flowchart code (start with 'flowchart TD'). Perfect for on-chain workflows, process flows, and architecture diagrams. Works without any API key.",
        parameters: z.object({
          title: z.string().optional(),
          mermaid: z.string().describe("Valid Mermaid flowchart code, e.g. 'flowchart TD\\n A[Start] --> B[End]'"),
        }),
        execute: async ({ title, mermaid }) => {
          try {
            const encoded = Buffer.from(mermaid).toString("base64url")
            const r = await fetch(`https://mermaid.ink/img/${encoded}`)
            if (!r.ok) return { error: "Could not render the diagram. Check the Mermaid syntax." }
            const imageBase64 = Buffer.from(await r.arrayBuffer()).toString("base64")
            return { kind: "image", title: title || "Diagram", imageBase64, mermaid }
          } catch {
            return { error: "Could not render the diagram." }
          }
        },
      }),

      generateImage: tool({
        description: "Generate an AI image/diagram from a text prompt using Gemini. Requires NEXT_PUBLIC_GEMINI_KEY; if unavailable, suggest generateDiagram instead.",
        parameters: z.object({ prompt: z.string(), isContract: z.boolean().optional() }),
        execute: async ({ prompt, isContract }) => {
          if (!process.env.NEXT_PUBLIC_GEMINI_KEY) {
            return { error: "Image generation needs NEXT_PUBLIC_GEMINI_KEY. Tip: the **generateDiagram** tool renders flowcharts without any key." }
          }
          try {
            // Call the handler in-process: no self-HTTP request, so it doesn't
            // depend on (client-controlled) Host headers or a configured base URL.
            const res = await generateImage(new NextRequest("http://internal/api/generate-image", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ prompt, isSmartContractWorkflow: !!isContract, type: isContract ? "workflow" : "general" }),
            }))
            const j = await res.json()
            if (!res.ok || !j.imageBase64) return { error: j.error || "Image generation failed." }
            return { kind: "image", title: "Generated image", imageBase64: j.imageBase64 }
          } catch {
            return { error: "Image generation failed." }
          }
        },
      }),

      swap: tool({
        description: "Swap one token for another on a Solana DEX. Requires a configured DEX/aggregator.",
        parameters: z.object({ fromToken: z.string(), toToken: z.string(), amount: z.string() }),
        execute: async ({ fromToken, toToken, amount }) => {
          const dex = process.env.SOLANA_DEX
          if (!dex) {
            return { kind: "swap", fromCurrency: fromToken, toCurrency: toToken, amount, status: "unavailable", note: "No DEX is configured yet. Set SOLANA_DEX to enable on-chain swaps." }
          }
          return { kind: "swap", fromCurrency: fromToken, toCurrency: toToken, amount, status: "router-configured", note: "DEX configured — swap execution wiring is a next step." }
        },
      }),
    },
  })

  return result.toDataStreamResponse()
}
