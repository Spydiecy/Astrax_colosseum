// Token swaps on Solana devnet through Raydium's Trade API.
//
// Jupiter only runs on mainnet, so on devnet we use Raydium's hosted router
// (transaction-v1-devnet.raydium.io): it quotes a route across Raydium's devnet
// pools and returns a ready-to-sign versioned transaction. No API key, no SDK.
//
// Every transaction it returns is checked before anyone signs it: the fee payer
// must be the user, and it may only call the Raydium devnet programs plus the
// standard System / Token / ATA / Compute Budget programs. The minimum output
// (slippage) is enforced on-chain by the swap instruction itself.
import "server-only"
import { PublicKey, VersionedTransaction } from "@solana/web3.js"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import { CLUSTER } from "./solana"

const TRADE_API = "https://transaction-v1-devnet.raydium.io"
const DATA_API = "https://api-v3-devnet.raydium.io"

/** Wrapped SOL mint. Raydium routes native SOL through it (wrapping/unwrapping in the tx). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112"

export const DEFAULT_SLIPPAGE_BPS = 100 // 1%
export const MAX_SLIPPAGE_BPS = 500 // 5%
/** Above this the swap is refused: devnet pools are thin and this would be a bad fill. */
export const MAX_PRICE_IMPACT_PCT = 30
/** Above this the card shows a warning. */
export const WARN_PRICE_IMPACT_PCT = 5

// Programs a swap transaction may call (devnet IDs from docs.raydium.io/reference/program-addresses).
const ALLOWED_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  "DRaybByLpbUL57LJARs3j8BitTxVfzBg351EaMr5UTCd", // Raydium AMM Routing
  "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb", // Raydium CPMM
  "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH", // Raydium CLMM
  "DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav", // Raydium AMM v4
])

export const swapsSupported = () => CLUSTER === "devnet"

export interface RouteHop {
  poolId: string
  inputMint: string
  outputMint: string
}

export interface SwapQuote {
  inputMint: string
  outputMint: string
  /** Raw base-unit amounts as decimal strings. */
  inAmount: string
  outAmount: string
  minOutAmount: string
  priceImpactPct: number
  slippageBps: number
  route: RouteHop[]
  /** The full quote response; the build endpoint needs it unchanged. */
  raw: unknown
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers || {}) }, cache: "no-store" })
  if (res.status === 429) throw new Error("Raydium is rate-limiting requests right now. Try again in a minute.")
  if (!res.ok) throw new Error(`Raydium API error (${res.status}).`)
  return res.json()
}

const FRIENDLY: Record<string, string> = {
  ROUTE_NOT_FOUND: "No devnet pool can swap these two tokens. Try SOL and USDC, or a smaller amount.",
  REQ_OWNER_ACCOUNT_ERROR: "Your wallet doesn't hold the token you're swapping from.",
  REQ_INPUT_ACCOUT_ERROR: "Your wallet doesn't hold the token you're swapping from.",
  INSUFFICIENT_LIQUIDITY: "There isn't enough devnet liquidity for that amount. Try a smaller amount.",
}
const friendly = (msg?: string) => (msg && FRIENDLY[msg]) || `Raydium couldn't do this swap${msg ? ` (${msg})` : ""}.`

/** Quote an exact-input swap. Amounts are raw base units. */
export async function quoteSwap(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<SwapQuote> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    txVersion: "V0",
  })
  const j = await getJson(`${TRADE_API}/compute/swap-base-in?${qs}`)
  if (!j?.success || !j.data) throw new Error(friendly(j?.msg))
  const d = j.data
  return {
    inputMint: d.inputMint,
    outputMint: d.outputMint,
    inAmount: String(d.inputAmount),
    outAmount: String(d.outputAmount),
    minOutAmount: String(d.otherAmountThreshold),
    priceImpactPct: Number(d.priceImpactPct) || 0,
    slippageBps: Number(d.slippageBps) || p.slippageBps,
    route: Array.isArray(d.routePlan)
      ? d.routePlan.map((r: any) => ({ poolId: String(r.poolId), inputMint: String(r.inputMint), outputMint: String(r.outputMint) }))
      : [],
    raw: j,
  }
}

/** Check a Raydium-built transaction before anyone signs it. Throws if anything is off. */
export function assertSafeSwapTx(tx: VersionedTransaction, wallet: string): void {
  const keys = tx.message.staticAccountKeys
  if (!keys[0] || keys[0].toBase58() !== wallet) throw new Error("The swap transaction has an unexpected fee payer.")
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error("The swap transaction asks for unexpected signers.")
  for (const ix of tx.message.compiledInstructions) {
    // Program IDs can't come from lookup tables, so they're always static keys.
    const program = keys[ix.programIdIndex]?.toBase58()
    if (!program || !ALLOWED_PROGRAMS.has(program)) {
      throw new Error("The swap transaction calls a program that isn't allowed.")
    }
  }
}

/** Build the swap transaction(s) for `wallet`, already safety-checked. Returns base64 strings, in signing order. */
export async function buildSwapTxs(p: {
  quote: SwapQuote
  wallet: string
  /** The user's token account for the input mint (omit for native SOL). */
  inputAccount?: string
  /** The user's token account for the output mint, if it already exists. */
  outputAccount?: string
}): Promise<string[]> {
  const isInSol = p.quote.inputMint === WSOL_MINT
  const isOutSol = p.quote.outputMint === WSOL_MINT
  const body = {
    computeUnitPriceMicroLamports: "50000",
    swapResponse: p.quote.raw,
    txVersion: "V0",
    wallet: p.wallet,
    wrapSol: isInSol,
    unwrapSol: isOutSol,
    ...(isInSol || !p.inputAccount ? {} : { inputAccount: p.inputAccount }),
    ...(isOutSol || !p.outputAccount ? {} : { outputAccount: p.outputAccount }),
  }
  const j = await getJson(`${TRADE_API}/transaction/swap-base-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!j?.success || !Array.isArray(j.data) || j.data.length === 0) throw new Error(friendly(j?.msg))
  const txs = j.data.map((d: any) => String(d.transaction))
  for (const b64 of txs) assertSafeSwapTx(VersionedTransaction.deserialize(Buffer.from(b64, "base64")), p.wallet)
  return txs
}

/** Best-effort symbols for mints in a route (from Raydium's devnet token list). */
export async function mintSymbols(mints: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(mints)].filter((m) => {
    try {
      return Boolean(new PublicKey(m))
    } catch {
      return false
    }
  })
  if (unique.length === 0) return {}
  try {
    const j = await getJson(`${DATA_API}/mint/ids?mints=${unique.join(",")}`)
    const out: Record<string, string> = {}
    for (const m of j?.data ?? []) if (m?.address && m.symbol) out[m.address] = String(m.symbol).slice(0, 12)
    return out
  } catch {
    return {}
  }
}

/** Raw base units → human string with up to `max` decimals, trailing zeros trimmed. */
export function fromBaseUnits(raw: string | bigint, decimals: number, max = 6): string {
  const v = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, Math.min(max, decimals)).replace(/0+$/, "")
  if (whole === 0n && frac === "" && v > 0n) frac = "0".repeat(Math.min(max, decimals) - 1) + "1" // tiny but non-zero
  return frac ? `${whole}.${frac}` : whole.toString()
}
