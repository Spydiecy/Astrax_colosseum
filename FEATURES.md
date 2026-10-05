# Astrax — Features

An AI agent for **Solana** (default cluster: devnet; native token **SOL**, 9 decimals)
that turns chat into on-chain actions.

## Network
- `NEXT_PUBLIC_CLUSTER`: `devnet` (default), `testnet` or `mainnet-beta`.
- RPC: `SOLANA_RPC_URL` (server) / `NEXT_PUBLIC_RPC_URL` (browser), else the public RPC.
- Explorer links go to `explorer.solana.com` with the right cluster.
- Known tokens (`lib/solana.ts`): SOL, plus Circle's USDC mint for the active cluster.

## Chat
- Streaming replies from Mistral `ministral-8b-latest` (Gemini fallback). Each tool
  result renders as a card under the reply.
- **Copy** any message, **edit** your own (it reruns from there), **regenerate** the
  latest reply. If the run being replaced already moved funds, you're warned first.
- **Chat history** with rename (pencil icon, double-click, or F2) and delete.
- **Stored only in your browser** (localStorage), for privacy. Nothing about your chats
  is kept on the server. Clearing site data or using a private window deletes them, and
  they don't sync to other devices. Large generated images aren't kept in history.
- Saves while a reply streams and syncs between open tabs. A failed request keeps your
  message and shows **Retry**.
- Replies render markdown (links, lists, tables, code). Raw HTML is never rendered.
- Image attachments (PNG, JPG, GIF, WebP, up to 10 MB, 4 per message) upload to IPFS
  through the server (`/api/upload`) as soon as you pick them. Each shows a thumbnail
  and "Uploaded to IPFS" (or why it was rejected). The server checks the file's real
  bytes, so a renamed non-image is refused. Voice input via the browser's speech API.

## Wallet and signing
- **Wallet mode:** any Wallet Standard wallet (Phantom, Solflare, Backpack…) is detected
  automatically. The agent prepares each transaction and a confirm button appears under
  its reply. Token and NFT creation is built in the browser so the new mint key never
  leaves it. Confirmed transactions are remembered, so a reload never offers to pay
  twice.
- **Autonomous mode:** paste a base58 (or JSON byte array) secret key. The server signs
  immediately. There are no buttons.
- The agent is told only the active mode, so replies match it.

## Agent tools
- **Read:** `getBalance`, `getTokenBalance`, `getTransaction`, `getLatestBlocks`,
  `getBlock`, `listTokens`, `getMarketData`, `getAddressActivity`, `explain`,
  `getPriceChart`.
- **Write:**
  - `sendPayment`: SOL, or any SPL / Token-2022 token.
  - `deployToken`: Token-2022 mint with on-chain name/symbol.
  - `deployNFT`: 1-of-1, mint authority revoked. Needs an attached image; the server
    uses the real upload (never a URL the model typed) and pins standard metadata JSON
    (`name`, `symbol`, `description`, `image`, `properties.files`) to IPFS.
  - `mintTokens`.
  - `scheduleTransfer` / `listSchedules` / `cancelSchedule`.
  - `createPaymentLink` / `listPaymentLinks`.
- **Utility:** contacts (`saveContact`, `resolveContact`, `listContacts`,
  `deleteContact`), assets (`storeAsset`, `listAssets`), `generateDiagram` (Mermaid) and
  `generateImage` (Gemini, optional).
- **Swaps:** `getSwapQuote` and `swap` (see below).
- Not supported: deploying arbitrary on-chain programs from chat.

## Payment links
- Created in chat ("payment link for 0.5 SOL for logo design"). Saved in the database, shared
  as `/pay/<id>` on whatever domain the app is opened on.
- **Pay page:** shows the amount, description, a Solana Pay QR code and a Pay button. It
  refreshes every 5 seconds while open.
- **Tracking:** each link has a random reference key that the payment includes. The
  server finds payments via that key and checks that the recipient received at least the
  amount in a confirmed transaction, then marks the link **paid** with the signature,
  payer and time.
- **Only payable by others:** the creator sees no Pay button, and payments they make
  don't count.
- Checks run when the pay page, the sidebar tab or the chat looks at the link. A payment
  made while nobody is watching shows up at the next check.
- **Sidebar "Payment links" tab:** status, copy, open, the payment transaction, and
  cancel (owner only).

## Scheduled payments
- One-time or recurring ("pay alice 1 SOL every week, 4 times"), autonomous mode only.
- The key is AES-256-GCM encrypted (`SCHEDULER_ENC_KEY`) in the database, used by
  `/api/cron/execute`, and wiped once the job finishes or is cancelled.
- No outside service needed. Any open Astrax tab triggers due jobs every minute, app
  traffic checks after each request, and 24 hourly Vercel crons (`CRON_SECRET`) cover
  the time nobody is online. So: within about a minute while the app is open anywhere,
  otherwise within the hour.
- Each job is claimed atomically, so it's sent once even if triggers overlap. An
  interrupted send is marked failed, never retried, so nothing is paid twice.
- **Sidebar "Scheduled" tab:** list and cancel (owner only).

## Token swaps (devnet)
- "Swap 0.01 SOL to USDC", "convert 5 USDC to SOL", or just a quote: "how much USDC for
  0.1 SOL?". Works with SOL, USDC or any mint address that has a devnet pool.
- Jupiter only runs on mainnet, so swaps go through Raydium's public Trade API for devnet
  (`lib/swap.ts`). It routes across Raydium's devnet pools (multi-hop) and returns a
  ready-to-sign transaction. No API key needed.
- **Cards:** you pay, you get (estimate, or the actual amount after an autonomous swap),
  minimum received, rate, price impact (amber above 5%), max slippage and route.
- **Wallet mode:** a Swap button, approved in your wallet. **Autonomous:** sent right away.
- **Safety:**
  - Default slippage is 1% (up to 5% if you ask). The minimum is enforced on-chain.
  - Swaps with more than 30% price impact are refused. Devnet pools are thin, so keep
    amounts small (around 0.01–0.05 SOL).
  - Balances are checked first (amount plus ~0.01 SOL for fees and rent).
  - Every Raydium-built transaction is checked before signing: your wallet must be the
    only signer and fee payer, and it may only call Raydium's devnet programs and the
    standard System / Token / ATA / Compute Budget programs.
  - A quote never turns into a swap unless your message asks to swap.
- Devnet prices come from test pools and don't match the real market. Swaps are off on
  other clusters for now.

## Contacts
- Each wallet has its own address book. Save from chat ("save alice as <address>") or in
  the sidebar **Contacts** tab (add, edit, delete, copy, search, open in explorer).
- Then just "send 1 SOL to alice" or "schedule 2 SOL to alice every week". Names only
  ever resolve from your own contacts.
- Names are case-insensitive; saving an existing name updates its address.

## Proving ownership
- Viewing or changing contacts, payment links and schedules (and listing stored assets)
  requires proving you control the address, by signing a free sign-in message:
  - **Wallet mode:** the wallet signs it (one popup, no transaction).
  - **Autonomous mode:** the loaded key signs it silently.
- The server verifies the signature and sets an HttpOnly session cookie for 7 days
  (`AUTH_SECRET`). Signed messages are single-use, expire after 5 minutes, and are bound
  to the site's domain. Disconnecting the wallet ends its session.
- Pay pages stay public, since payers need them.

## Storage and deployment
- **Browser:** chats only.
- **Database (libSQL):** contacts, schedules, payment links and assets, each row tied to
  its wallet. It also holds used sign-in nonces and upload rate limits, so those hold
  across servers.
- **Where:** locally a file at `.data/astrax.db`; on Vercel a hosted Turso database via
  `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (free tier is enough). See the README.
