"use client"

import { useChat } from "@ai-sdk/react"
import { useEffect, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import {
  Bot, User, Send, Mic, MicOff, Loader2, Wallet, ArrowUpRight,
  Boxes, LineChart, Link2, Copy, Check, CalendarClock, FileText, Rocket,
  Paperclip, X, Image as ImageIcon, Code, ShieldCheck, ShieldAlert, Info, AlertTriangle,
  Pencil, RotateCcw, ArrowLeftRight,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCredentials } from "@/contexts/CredentialsContext"
import { OnboardingModal } from "@/components/onboarding-modal"
import { TxActionButton, type PendingAction } from "@/components/ui/tx-action-button"
import TokenListCard from "@/components/ui/token-list-card"
import CandlestickChart from "@/components/ui/candlestick-chart"
import { AgentSteps } from "@/components/ui/agent-steps"
import { Markdown } from "@/components/ui/markdown"

import { getCurrentId, newChat, getMessages, saveMessages, chatStorageKey } from "@/lib/chat-history"
import { explorerTx } from "@/lib/solana"
import { absoluteUrl } from "@/lib/origin"
import { VerifyWalletPrompt } from "@/components/verify-wallet"
import { checkImageFile, IMAGE_ACCEPT, IMAGE_FORMATS_LABEL } from "@/lib/images"
import type { Message } from "@ai-sdk/react"

// The model sometimes invents UI markup such as "<ConfirmButton>" for the button
// the app renders itself. Strip component-style (PascalCase) tags, including a
// cut-off one at the end, and tidy a dangling colon left behind.
function cleanAssistantText(text: string): string {
  let t = text
    .replace(/<\/?[A-Z][A-Za-z0-9]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/<\/?[A-Z][A-Za-z0-9]*[^<>]*$/, "")
    // Placeholder "buttons" on their own line, e.g. "*[Confirm Button]*" (not real links).
    .replace(/^[ \t]*[*_]*\[[^\]\n]{1,40}\](?!\()[*_]*[ \t]*$/gm, "")
  // Trailing separators left behind by the removals above.
  t = t.replace(/(\s*(^|\n)\s*(-{3,}|\*{3,}|_{3,})\s*)+$/, "")
  return t.replace(/\s+$/, "").replace(/:$/, ".")
}

// URLs that this message's tool cards already display (payment links, explorer links).
function cardUrls(invocations: any[]): Set<string> {
  const urls = new Set<string>()
  const add = (u?: string) => {
    if (typeof u !== "string" || !u) return
    urls.add(u)
    try { urls.add(new URL(u).pathname) } catch { /* relative */ }
  }
  for (const inv of invocations ?? []) {
    const r = inv?.result
    if (!r) continue
    add(r.url); add(r.path); add(r.explorerUrl); add(r.image); add(r.metadataUri)
    for (const l of r.links ?? []) { add(l.url); add(l.path) }
  }
  return urls
}

/**
 * Drop lines whose only content is a link the card below already shows
 * (e.g. "🔗 **[0.01 SOL](http://…/pay/pl_…)**"). Links inside a sentence stay.
 */
function dropCardLinkLines(text: string, urls: Set<string>): string {
  if (urls.size === 0) return text
  const known = (href: string) => {
    if (urls.has(href)) return true
    try { return urls.has(new URL(href).pathname) } catch { return false }
  }
  const out = text.split("\n").filter((line) => {
    let hit = false
    const rest = line
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, _t, href) => (known(href) ? ((hit = true), "") : m))
      .replace(/https?:\/\/[^\s)<>*]+/g, (m) => {
        const url = m.replace(/[.,;:!?]+$/, "")
        return known(url) ? ((hit = true), m.slice(url.length)) : m
      })
    // Nothing left but decoration (bullets, emphasis markers, emoji, punctuation)?
    return !(hit && rest.replace(/[\s*_`~>#\-–—•:|.()[\]]|\p{Extended_Pictographic}|\uFE0F/gu, "") === "")
  })
  return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

// ── Per-message action row (copy / edit / regenerate) ───────────────────────────
function MsgAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="p-1.5 rounded-md text-gray-500 hover:text-black dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-900 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
    >
      {children}
    </button>
  )
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <MsgAction
      label={copied ? "Copied" : "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard blocked (e.g. insecure context) */
        }
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </MsgAction>
  )
}

// True if any of these messages contains an action the server already executed
// (autonomous sends/mints/creates, or a created schedule). Wallet-mode results
// are kind "action" (not sent yet) and getTransaction lookups have no `action`.
function ranOnChain(msgs: any[]): boolean {
  return msgs.some((m) =>
    (m.toolInvocations ?? []).some((inv: any) => {
      const r = inv.state === "result" ? inv.result : null
      if (!r || r.error) return false
      return r.kind === "deploy" || r.kind === "schedule" || r.kind === "swap" || (r.kind === "transaction" && (r.action === "send" || r.action === "mint"))
    }),
  )
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
    </button>
  )
}

/** Rows shared by the swap quote, wallet-mode swap and completed-swap cards. */
function SwapDetails({ s }: { s: any }) {
  const impactTone = s.tooHighImpact
    ? "text-red-600 dark:text-red-400"
    : s.highImpact
      ? "text-amber-600 dark:text-amber-400"
      : ""
  return (
    <>
      <Field label="You pay">{s.from?.amount} {s.from?.symbol}</Field>
      <Field label={s.received ? "You got" : "You get (est.)"}>
        <span className="font-medium">{s.received ?? s.to?.amount} {s.to?.symbol}</span>
      </Field>
      {!s.received && <Field label="Minimum received">{s.to?.min} {s.to?.symbol}</Field>}
      <Field label="Rate">{s.rate}</Field>
      <Field label="Price impact">
        <span className={cn("inline-flex items-center gap-1", impactTone)}>
          {(s.highImpact || s.tooHighImpact) && <AlertTriangle className="w-3.5 h-3.5" aria-hidden />}
          {Number(s.priceImpactPct ?? 0).toFixed(2)}%
        </span>
      </Field>
      <Field label="Max slippage">{s.slippagePct}%</Field>
      {Array.isArray(s.route) && (
        <Field label="Route">
          <span className="text-right">{s.route.join(" → ")} <span className="text-gray-500">· {s.venue}</span></span>
        </Field>
      )}
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Devnet prices come from test pools, so they don&apos;t match the real market.
      </p>
    </>
  )
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 text-sm py-1">
    <span className="text-gray-500 dark:text-gray-400">{label}</span>
    <span className="font-medium text-right break-all">{children}</span>
  </div>
)

const CardShell = ({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <div className="mt-3 w-full max-w-xl rounded-lg border border-gray-300 dark:border-gray-800 bg-white dark:bg-black p-4">
    <div className="flex items-center gap-2 mb-3 text-sm font-medium">
      <div className="w-7 h-7 rounded-full bg-gray-800 dark:bg-white text-white dark:text-black flex items-center justify-center">{icon}</div>
      {title}
    </div>
    {children}
  </div>
)

const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "")

/** Upload an image to IPFS through the server (the Pinata key stays server-side). */
async function uploadToIPFS(file: File): Promise<{ url: string; contentType: string }> {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch("/api/upload", { method: "POST", body: form })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ipfsUrl) throw new Error(j.error || `Upload failed (${res.status})`)
  return { url: j.ipfsUrl as string, contentType: (j.contentType as string) || file.type }
}

/** An image picked in the composer. It uploads right away so you can see it worked. */
interface PendingImage {
  id: string
  name: string
  /** Local preview (object URL), revoked when the chip goes away. */
  preview: string
  status: "uploading" | "done" | "error"
  url?: string
  contentType?: string
  error?: string
}

const MAX_ATTACHMENTS = 4

/** Text the model sees for a message's attached images (the bubble only shows thumbnails). */
function attachmentNote(atts: any[] | undefined): string {
  const imgs = (atts || []).filter((a) => a?.url && String(a.contentType || "").startsWith("image/"))
  if (imgs.length === 0) return ""
  const list = imgs.map((a) => `"${a.name}": ${a.url}`).join(" | ")
  return `\n\n[The user attached ${imgs.length === 1 ? "an image" : `${imgs.length} images`}, already uploaded to IPFS: ${list}. For an NFT, deployNFT uses it automatically.]`
}

// ── Image / diagram card (generated images + mermaid diagrams) ──────────────────
function ImageCard({ result }: { result: any }) {
  const [showSource, setShowSource] = useState(false)
  const src = result.imageBase64 ? `data:image/png;base64,${result.imageBase64}` : result.imageUrl
  return (
    <div className="mt-3 w-full max-w-xl rounded-lg border border-gray-300 dark:border-gray-800 bg-white dark:bg-black p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <div className="w-7 h-7 rounded-full bg-gray-800 dark:bg-white text-white dark:text-black flex items-center justify-center"><ImageIcon className="w-4 h-4" /></div>
          {result.title || "Image"}
        </div>
        {src && (
          <a href={src} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline">
            Open <ArrowUpRight className="w-3 h-3" />
          </a>
        )}
      </div>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={result.title || "generated image"} className="w-full rounded-md border border-gray-200 dark:border-gray-800" />
      ) : (
        <p className="text-xs text-gray-500 rounded-md border border-dashed border-gray-300 dark:border-gray-700 p-3">
          This image was too large to keep in saved chat history. Ask again to regenerate it.
        </p>
      )}
      {result.mermaid && (
        <div className="mt-2">
          <button onClick={() => setShowSource((s) => !s)} className="text-xs text-gray-500 hover:text-black dark:hover:text-white inline-flex items-center gap-1">
            <Code className="w-3.5 h-3.5" /> {showSource ? "Hide" : "View"} Mermaid source
          </button>
          {showSource && (
            <pre className="mt-2 text-xs font-mono bg-gray-100 dark:bg-gray-900 rounded-md p-3 overflow-x-auto whitespace-pre-wrap">{result.mermaid}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Full payment-link URL on the domain currently open. Tracked links carry a
 * path (/pay/<id>); older saved results only have an absolute url, so its path
 * is re-based onto this domain too (legacy /payment-link/… links keep working).
 */
function linkHref(r: { path?: string; url?: string }): string {
  if (r.path) return absoluteUrl(r.path)
  if (!r.url) return ""
  try {
    const u = new URL(r.url)
    return absoluteUrl(u.pathname + u.search)
  } catch {
    return r.url
  }
}

// ── Render a tool result into a card ────────────────────────────────────────────
function ToolCard({ result, callId }: { result: any; callId?: string }) {
  if (result?.needsAuth) {
    return (
      <div className="mt-3 w-full max-w-xl">
        <VerifyWalletPrompt />
        <p className="mt-1 text-xs text-gray-500">After verifying, ask again.</p>
      </div>
    )
  }
  if (!result || result.error) {
    return result?.error ? (
      <div className="mt-3 w-full max-w-xl rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
        <Markdown text={result.error} />
      </div>
    ) : null
  }

  // Wallet-mode prepared transaction → render a one-click confirm button.
  if (result.kind === "action") {
    if (result.action === "swap" && result.swap) {
      return (
        <div className="w-full max-w-xl">
          <CardShell icon={<ArrowLeftRight className="w-4 h-4" />} title="Swap">
            <SwapDetails s={result.swap} />
          </CardShell>
          <TxActionButton id={callId} action={result as PendingAction} />
        </div>
      )
    }
    return <TxActionButton id={callId} action={result as PendingAction} />
  }

  switch (result.kind) {
    case "balance":
      return (
        <CardShell icon={<Wallet className="w-4 h-4" />} title="Balance">
          <Field label="Address">{short(result.address)}</Field>
          <Field label="Balance">{result.balance} {result.symbol}</Field>
          {result.usdValue && <Field label="≈ USD">${result.usdValue}</Field>}
        </CardShell>
      )
    case "transaction":
      return (
        <CardShell icon={<ArrowUpRight className="w-4 h-4" />} title={result.action === "send" ? "Payment Sent" : result.action === "mint" ? "Tokens Minted" : "Transaction"}>
          <div className="flex items-center justify-between gap-3 text-sm py-1">
            <span className="text-gray-500 dark:text-gray-400">Signature</span>
            <span className="font-mono text-xs flex items-center gap-1">{short(result.hash)} <CopyBtn value={result.hash} /></span>
          </div>
          {result.status && <Field label="Status">{result.status}</Field>}
          {result.from && <Field label="From">{short(result.from)}</Field>}
          {result.to && <Field label="To">{short(result.to)}</Field>}
          {result.value && <Field label="Value">{result.value}</Field>}
          {result.blockNumber && <Field label="Block">{result.blockNumber}</Field>}
          {result.fee && <Field label="Fee">{result.fee}</Field>}
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
            View on Solana Explorer <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        </CardShell>
      )
    case "blocks":
      return (
        <CardShell icon={<Boxes className="w-4 h-4" />} title="Latest Blocks">
          <div className="space-y-2">
            {result.blocks.map((b: any) => (
              <div key={b.blockNumber} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-sm">
                <div className="flex justify-between"><span className="font-medium">#{b.blockNumber}</span><span className="text-gray-500">{b.transactionCount} txns</span></div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{b.timestamp}</div>
              </div>
            ))}
          </div>
        </CardShell>
      )
    case "block":
      return (
        <CardShell icon={<Boxes className="w-4 h-4" />} title={`Slot #${result.blockNumber}`}>
          <Field label="Hash">{short(result.hash)}</Field>
          <Field label="Time">{result.timestamp}</Field>
          <Field label="Transactions">{result.transactionCount}</Field>
          {result.parentSlot && <Field label="Parent slot">{result.parentSlot}</Field>}
        </CardShell>
      )
    case "tokenList":
      return <div className="mt-3 w-full max-w-xl"><TokenListCard tokens={result.tokens} /></div>
    case "candlestick":
      return (
        <div className="mt-3 w-full max-w-2xl">
          <CandlestickChart data={result.data} symbol={result.symbol} days={result.days} />
          {result.indicative && (
            <p className="mt-1 text-xs text-gray-500">Indicative series — {result.symbol} has no live Coinbase market, derived from spot price.</p>
          )}
        </div>
      )
    case "image":
      return <ImageCard result={result} />
    case "market":
      return (
        <CardShell icon={<LineChart className="w-4 h-4" />} title={`${result.name} Market`}>
          {result.price != null && <Field label="Price">${result.price}</Field>}
          {result.change24h != null && <Field label="24h"><span className={result.change24h >= 0 ? "text-green-500" : "text-red-500"}>{result.change24h.toFixed(2)}%</span></Field>}
          {result.marketCap != null && <Field label="Market Cap">${Number(result.marketCap).toLocaleString()}</Field>}
          {result.volume24h != null && <Field label="24h Volume">${Number(result.volume24h).toLocaleString()}</Field>}
        </CardShell>
      )
    case "activity":
      return (
        <CardShell icon={<LineChart className="w-4 h-4" />} title="Recent Activity">
          <div className="space-y-2">
            {result.transactions.length === 0 && (
              <p className="text-sm text-gray-500">{result.note || "No recent transactions."}</p>
            )}
            {result.transactions.map((t: any) => (
              <a key={t.hash} href={explorerTx(t.hash)} target="_blank" rel="noreferrer" className="block rounded border border-gray-200 dark:border-gray-800 p-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-900">
                <div className="flex justify-between"><span className="font-mono text-xs">{short(t.hash)}</span><span className={t.status === "Failed" ? "text-red-500" : "text-gray-500"}>{t.status}</span></div>
                {t.timestamp && <div className="text-xs text-gray-500">{t.timestamp}</div>}
              </a>
            ))}
            {result.explorerUrl && (
              <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
                View on Solana Explorer <ArrowUpRight className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </CardShell>
      )
    case "deploy":
      return (
        <CardShell icon={<Rocket className="w-4 h-4" />} title={result.what === "nft" ? "NFT Created" : "Token Created"}>
          {result.name && <Field label="Name">{result.name}{result.symbol ? ` (${result.symbol})` : ""}</Field>}
          {result.supply && <Field label="Supply">{result.supply}</Field>}
          {result.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.image} alt={`${result.name || "NFT"} artwork`} className="my-2 max-h-56 rounded-md border border-gray-200 dark:border-gray-800" />
          )}
          {(result.image || result.metadataUri) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs py-1">
              {result.image && (
                <a href={result.image} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
                  Image on IPFS <ArrowUpRight className="w-3 h-3" />
                </a>
              )}
              {result.metadataUri && (
                <a href={result.metadataUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
                  Metadata JSON <ArrowUpRight className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 text-sm py-1">
            <span className="text-gray-500 dark:text-gray-400">Mint</span>
            <span className="font-mono text-xs flex items-center gap-1">{short(result.contractAddress)} <CopyBtn value={result.contractAddress || ""} /></span>
          </div>
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
            View on Solana Explorer <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        </CardShell>
      )
    case "schedule":
      return (
        <CardShell icon={<CalendarClock className="w-4 h-4" />} title="Transfer Scheduled">
          <Field label="To">{short(result.to)}</Field>
          <Field label="Amount">{result.amount}</Field>
          <Field label="First run">{result.runAt}</Field>
          {result.recurrence && result.recurrence !== "once" && <Field label="Repeats">{result.recurrence}</Field>}
          {result.note && <p className="mt-2 text-xs text-gray-500">{result.note}</p>}
        </CardShell>
      )
    case "scheduleList":
      return (
        <CardShell icon={<CalendarClock className="w-4 h-4" />} title="Scheduled Payments">
          {result.schedules.length === 0 ? <p className="text-sm text-gray-500">Nothing scheduled.</p> : result.schedules.map((s: any) => (
            <div key={s.id} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-sm mb-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.amount}</span>
                <span className="text-xs text-gray-500">{s.status}{s.recurrence && s.recurrence !== "once" ? ` · ${s.recurrence}` : ""}</span>
              </div>
              <div className="text-xs text-gray-500">To {short(s.to)} · {s.runAt}</div>
            </div>
          ))}
        </CardShell>
      )
    case "scheduleCancelled":
      return (
        <CardShell icon={<CalendarClock className="w-4 h-4" />} title="Schedule Cancelled">
          <Field label="ID">{result.id}</Field>
        </CardShell>
      )
    case "paymentLink": {
      const url = linkHref(result)
      return (
        <CardShell icon={<Link2 className="w-4 h-4" />} title="Payment Link">
          {result.description && <Field label="For">{result.description}</Field>}
          <Field label="Amount">{result.amount}</Field>
          <div className="mt-2 flex items-center gap-2 rounded border border-gray-200 dark:border-gray-800 p-2">
            <span className="font-mono text-xs flex-1 break-all">{url}</span>
            <CopyBtn value={url} />
          </div>
          <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
            Open link <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
          {result.id && <p className="mt-2 text-xs text-gray-500">Tracked — it&apos;s marked paid automatically. See the sidebar <strong>Payment links</strong> tab.</p>}
        </CardShell>
      )
    }
    case "paymentLinkList":
      return (
        <CardShell icon={<Link2 className="w-4 h-4" />} title="Payment Links">
          {result.links.length === 0 ? <p className="text-sm text-gray-500">No payment links yet.</p> : result.links.map((l: any) => (
            <div key={l.id} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-sm mb-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{l.amount}</span>
                <span className={cn("text-xs font-medium", l.status === "paid" ? "text-green-500" : l.status === "open" ? "text-blue-500" : "text-gray-400")}>{l.status}</span>
              </div>
              {l.description && <div className="text-xs text-gray-500 truncate">{l.description}</div>}
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span className="font-mono truncate flex-1">{linkHref(l)}</span>
                <CopyBtn value={linkHref(l)} />
              </div>
            </div>
          ))}
        </CardShell>
      )
    case "contact":
      return (
        <CardShell icon={<User className="w-4 h-4" />} title={result.saved ? "Contact Saved" : "Contact"}>
          <Field label="Name">{result.name}</Field>
          <Field label="Address">{short(result.address)}</Field>
        </CardShell>
      )
    case "contactDeleted":
      return (
        <CardShell icon={<User className="w-4 h-4" />} title="Contact Removed">
          <Field label="Name">{result.name}</Field>
        </CardShell>
      )
    case "contactList":
      return (
        <CardShell icon={<User className="w-4 h-4" />} title="Contacts">
          {result.contacts.length === 0 ? <p className="text-sm text-gray-500">No contacts saved.</p> : result.contacts.map((c: any) => (
            <Field key={c.name} label={c.name}>{short(c.address)}</Field>
          ))}
        </CardShell>
      )
    case "asset":
      return (
        <CardShell icon={<FileText className="w-4 h-4" />} title="Asset Stored">
          <Field label="Description">{result.description}</Field>
          <Field label="Link">{result.link}</Field>
        </CardShell>
      )
    case "assetList":
      return (
        <CardShell icon={<FileText className="w-4 h-4" />} title="Your Assets">
          {result.assets.length === 0 ? <p className="text-sm text-gray-500">No assets stored.</p> : result.assets.map((a: any, i: number) => (
            <div key={i} className="rounded border border-gray-200 dark:border-gray-800 p-2 text-sm mb-2">
              <div className="font-medium">{a.description}</div>
              <div className="text-xs text-gray-500 break-all">{a.link}</div>
            </div>
          ))}
        </CardShell>
      )
    case "explain": {
      const riskStyle = (lvl: string) =>
        lvl === "high"
          ? "bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-900/60 text-red-700 dark:text-red-300"
          : lvl === "medium"
            ? "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-900/60 text-amber-700 dark:text-amber-300"
            : "bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-300"
      const RiskIcon = ({ lvl }: { lvl: string }) =>
        lvl === "high" ? <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : lvl === "medium" ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
      return (
        <CardShell icon={<ShieldCheck className="w-4 h-4" />} title={result.title}>
          <p className="text-sm mb-3 text-gray-700 dark:text-gray-200">{result.summary}</p>
          {result.fields?.map((f: any, i: number) => (
            <Field key={i} label={f.label}>{f.mono ? <span className="font-mono text-xs">{f.value}</span> : f.value}</Field>
          ))}
          {result.method && (
            <div className="mt-3 rounded-md border border-gray-200 dark:border-gray-800 p-2">
              {result.method.name === "functions" ? (
                <>
                  <div className="text-xs text-gray-500 mb-1.5">Functions ({result.method.params.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {result.method.params.map((p: any, i: number) => (
                      <span key={i} className="text-xs font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">{p.name}</span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-xs text-gray-500 mb-1">Decoded call: <span className="font-mono text-black dark:text-white">{result.method.name}</span></div>
                  {result.method.params.map((p: any, i: number) => (
                    <div key={i} className="text-xs flex gap-2 py-0.5">
                      <span className="text-gray-500 whitespace-nowrap">{p.name || p.type}</span>
                      <span className="font-mono break-all text-right flex-1">{p.value}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {result.risks?.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {result.risks.map((r: any, i: number) => (
                <div key={i} className={cn("flex items-start gap-2 text-xs rounded-md px-2.5 py-2 border", riskStyle(r.level))}>
                  <RiskIcon lvl={r.level} />
                  <span>{r.text}</span>
                </div>
              ))}
            </div>
          )}
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
            View on Solana Explorer <ArrowUpRight className="w-3.5 h-3.5" />
          </a>
        </CardShell>
      )
    }
    case "swap":
      return (
        <CardShell icon={<ArrowLeftRight className="w-4 h-4" />} title="Swap Complete">
          <SwapDetails s={result} />
          <div className="flex items-center justify-between gap-3 text-sm py-1">
            <span className="text-gray-500 dark:text-gray-400">Signature</span>
            <span className="font-mono text-xs flex items-center gap-1">{short(result.hash)} <CopyBtn value={result.hash || ""} /></span>
          </div>
          {result.explorerUrl && (
            <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline">
              View on Solana Explorer <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          )}
        </CardShell>
      )
    case "swapQuote":
      return (
        <CardShell icon={<ArrowLeftRight className="w-4 h-4" />} title="Swap Quote">
          <SwapDetails s={result} />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {result.tooHighImpact
              ? "Price impact is too high, so Astrax won't make this swap. Try a smaller amount."
              : "Just a quote, nothing was swapped. Ask to swap when you're ready."}
          </p>
        </CardShell>
      )
    default:
      return null
  }
}

const WELCOME = `Hey, I'm **Astrax** 👋 — your AI agent for **Solana**.

Try things like:
- "What's my **SOL** balance?"
- "Send **1 SOL** to \`<address>\`"
- "Create a token **MoonCoin MOON** supply **1000000**", or attach an image and say "**mint this as an NFT**"
- "Show the **latest blocks**" or "**SOL** market data"
- "Create a **payment link** for 0.5 SOL"
- "**Swap 0.01 SOL** to USDC"
- "Schedule **2 SOL** to \`<address>\` **in 10 minutes**"

Pick a signing mode in the sidebar **Signing** panel — connect a **wallet** (approve each txn with a button) or go **autonomous** with a secret key. Tap **How it works** anytime for the tour.`

const SUGGESTIONS = [
  { icon: <Wallet className="w-3.5 h-3.5" />, label: "Check my SOL balance", prompt: "What's my SOL balance?" },
  { icon: <LineChart className="w-3.5 h-3.5" />, label: "SOL price chart", prompt: "Show me the SOL price chart for the last 7 days" },
  { icon: <ArrowLeftRight className="w-3.5 h-3.5" />, label: "Swap quote", prompt: "How much USDC would I get for 0.01 SOL?" },
  { icon: <Rocket className="w-3.5 h-3.5" />, label: "Create a token", prompt: "Create a token called MoonCoin with symbol MOON and supply 1000000" },
  { icon: <Code className="w-3.5 h-3.5" />, label: "Workflow diagram", prompt: "Draw a workflow diagram for minting an SPL token" },
  { icon: <Link2 className="w-3.5 h-3.5" />, label: "Payment link", prompt: "Create a payment link for 0.5 SOL" },
  { icon: <Boxes className="w-3.5 h-3.5" />, label: "Latest blocks", prompt: "Show me the latest blocks on Solana" },
  { icon: <ShieldCheck className="w-3.5 h-3.5" />, label: "Explain an address", prompt: "Explain this address and tell me if it's safe: So11111111111111111111111111111111111111112" },
]

// Outer manager: owns the active chat id and swaps the keyed session on open.
export default function AstraxChatPage() {
  const [chatId, setChatId] = useState<string | null>(null)

  useEffect(() => {
    let id = getCurrentId()
    if (!id) id = newChat()
    setChatId(id)
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.id) setChatId(detail.id)
    }
    window.addEventListener("astrax:chat-open", onOpen)
    return () => window.removeEventListener("astrax:chat-open", onOpen)
  }, [])

  if (!chatId) return null
  return <ChatSession key={chatId} chatId={chatId} />
}

function ChatSession({ chatId }: { chatId: string }) {
  const { privateKey, signingMode } = useCredentials()
  const { publicKey } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const [isRecording, setIsRecording] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [images, setImages] = useState<PendingImage[]>([])
  const [attachError, setAttachError] = useState("")
  const uploading = images.some((i) => i.status === "uploading")
  const hasFailed = images.some((i) => i.status === "error")
  const readyImages = images.filter((i) => i.status === "done")
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)

  // Keep the latest signing context in a ref so each request sends fresh values.
  const ctxRef = useRef({ privateKey, signingMode, address })
  ctxRef.current = { privateKey, signingMode, address }

  const stored = getMessages(chatId)
  const initialMessages: Message[] =
    stored.length > 0 ? (stored as unknown as Message[]) : [{ id: "welcome", role: "assistant", content: WELCOME }]

  const { messages, input, handleInputChange, handleSubmit, status, setInput, append, setMessages, reload, error } = useChat({
    api: "/api/agent",
    id: chatId,
    initialMessages,
    // On a failed request (rate limit, server restart…) keep the user's message
    // instead of silently rolling the chat back; a Retry button is shown.
    keepLastMessageOnError: true,
    experimental_prepareRequestBody: ({ messages }) => ({
      // Keep the model text-only: attached images become a short note with their
      // IPFS links instead of image parts.
      messages: messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.role === "user" ? `${m.content || ""}${attachmentNote(m.experimental_attachments)}`.trim() : m.content,
        toolInvocations: m.toolInvocations,
      })),
      // Which images each message carried, so the server picks the real uploaded
      // image for an NFT instead of trusting a URL the model typed.
      attachments: Object.fromEntries(
        messages
          .filter((m: any) => m.role === "user" && m.experimental_attachments?.length)
          .map((m: any) => [
            m.id,
            m.experimental_attachments
              .filter((a: any) => a?.url && String(a.contentType || "").startsWith("image/"))
              .map((a: any) => ({ url: a.url, contentType: a.contentType })),
          ]),
      ),
      signingMode: ctxRef.current.signingMode,
      credentials: { privateKey: ctxRef.current.privateKey },
      walletAddress: ctxRef.current.address ?? null,
    }),
  })

  const isLoading = status === "submitted" || status === "streaming"

  // ── Edit / regenerate ──────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")

  // Re-running a turn that already moved funds autonomously would do it again.
  const okToRerun = (dropped: any[]) =>
    !ranOnChain(dropped) ||
    window.confirm("This conversation already ran an on-chain action from here on. Re-running may execute it again (e.g. send another payment). Continue?")

  const submitEdit = (idx: number) => {
    const text = editText.trim()
    if (!text || isLoading) return
    const original = messages[idx] as any
    if (text === original.content.trim()) {
      setEditingId(null)
      return
    }
    if (!okToRerun(messages.slice(idx))) return
    setEditingId(null)
    // Drop this message and everything after it, then send the edited version.
    setMessages(messages.slice(0, idx))
    append({ role: "user", content: text, experimental_attachments: original.experimental_attachments })
  }

  const regenerate = () => {
    if (isLoading) return
    const last = messages[messages.length - 1]
    if (last?.role === "assistant" && !okToRerun([last])) return
    reload()
  }

  // Show the tutorial once per browser, and when the header button asks for it.
  useEffect(() => {
    if (!localStorage.getItem("astrax_onboarded")) setShowOnboarding(true)
    const open = () => setShowOnboarding(true)
    window.addEventListener("openOnboarding", open)
    return () => window.removeEventListener("openOnboarding", open)
  }, [])

  const closeOnboarding = () => {
    localStorage.setItem("astrax_onboarded", "1")
    setShowOnboarding(false)
  }

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages])

  // Persist the conversation: immediately when a turn settles, and at most once a
  // second while a reply streams, so a reload/refresh mid-turn doesn't lose it.
  const latestRef = useRef(messages)
  latestRef.current = messages
  useEffect(() => {
    if (status === "ready" || status === "error") {
      saveMessages(chatId, messages as any)
      return
    }
    const t = setTimeout(() => saveMessages(chatId, latestRef.current as any), 1000)
    return () => clearTimeout(t)
  }, [status, messages, chatId])
  useEffect(() => {
    const flush = () => saveMessages(chatId, latestRef.current as any)
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
  }, [chatId])

  // Another tab updated this chat → adopt its version (when idle), so a stale
  // tab can't overwrite newer history the next time it saves.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== chatStorageKey(chatId) || !e.newValue || isLoading) return
      try {
        setMessages(JSON.parse(e.newValue))
      } catch {
        /* ignore malformed */
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [chatId, isLoading, setMessages])

  const toggleRecording = () => {
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition
    if (!SR) { alert("Speech recognition isn't supported in this browser. Try Chrome, Edge, or Safari."); return }
    if (isRecording) { recognitionRef.current?.stop(); setIsRecording(false); return }
    const rec = new SR()
    rec.lang = "en-US"; rec.continuous = false; rec.interimResults = true
    rec.onresult = (e: any) => {
      let t = ""
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) t += e.results[i][0].transcript
      if (t) setInput(input + t)
    }
    rec.onend = () => setIsRecording(false)
    rec.onerror = () => setIsRecording(false)
    recognitionRef.current = rec
    rec.start(); setIsRecording(true)
  }

  const canSend = !isLoading && !uploading && !hasFailed && (input.trim().length > 0 || readyImages.length > 0)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSend) return

    // Images are already on IPFS (uploaded when picked); attach their links.
    if (readyImages.length > 0) {
      const attachments = readyImages.map((i) => ({ name: i.name, contentType: i.contentType || "image/png", url: i.url! }))
      readyImages.forEach((i) => URL.revokeObjectURL(i.preview))
      setImages([])
      setAttachError("")
      setInput("")
      append({ role: "user", content: input.trim(), experimental_attachments: attachments })
      return
    }

    handleSubmit(e)
  }

  const updateImage = (id: string, patch: Partial<PendingImage>) =>
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))

  const removeImage = (id: string) =>
    setImages((prev) => {
      const gone = prev.find((i) => i.id === id)
      if (gone) URL.revokeObjectURL(gone.preview)
      return prev.filter((i) => i.id !== id)
    })

  // Validate and upload each picked image straight away, so its chip shows
  // "Uploading…" → "On IPFS" (or the reason it was rejected) before you send.
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    if (fileInputRef.current) fileInputRef.current.value = ""
    if (picked.length === 0) return

    const room = MAX_ATTACHMENTS - images.length
    const problems: string[] = []
    if (picked.length > room) problems.push(`You can attach up to ${MAX_ATTACHMENTS} images per message.`)

    const accepted: { item: PendingImage; file: File }[] = []
    for (const file of picked.slice(0, Math.max(0, room))) {
      const err = checkImageFile(file)
      if (err) {
        problems.push(err)
        continue
      }
      const item: PendingImage = { id: crypto.randomUUID(), name: file.name, preview: URL.createObjectURL(file), status: "uploading" }
      accepted.push({ item, file })
    }
    setAttachError(problems.join(" "))
    if (accepted.length === 0) return
    setImages((prev) => [...prev, ...accepted.map((a) => a.item)])

    for (const { item, file } of accepted) {
      uploadToIPFS(file)
        .then(({ url, contentType }) => updateImage(item.id, { status: "done", url, contentType }))
        .catch((err: any) => updateImage(item.id, { status: "error", error: err?.message || "Upload failed" }))
    }
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-black text-black dark:text-white transition-colors duration-300">
      <OnboardingModal
        isOpen={showOnboarding}
        onClose={closeOnboarding}
        onTryPrompt={(p) => { closeOnboarding(); setInput(p) }}
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="w-full space-y-5">
          {messages.map((m, idx) => {
            const invocations = (m as any).toolInvocations ?? []
            const isLastAssistant = idx === messages.length - 1 && m.role === "assistant"
            const stepsActive = isLoading && isLastAssistant
            const isEditing = editingId === m.id
            const shown = m.role === "assistant"
              ? cleanAssistantText(dropCardLinkLines(m.content || "", cardUrls(invocations)))
              : m.content
            const canRegenerate = isLastAssistant && !isLoading && messages.slice(0, idx).some((x) => x.role === "user")
            // Action rows fade in on hover/focus; always shown for the latest reply and on touch screens.
            const actionsVisibility = isLastAssistant && !isLoading
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
            return (
              <div key={m.id} className={cn("group flex items-start gap-3", m.role === "user" ? "flex-row-reverse" : "")}>
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                  m.role === "assistant" ? "bg-gray-200 dark:bg-gray-800" : "bg-gray-800 dark:bg-white text-white dark:text-black",
                )}>
                  {m.role === "assistant" ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                </div>
                <div className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start", "max-w-[85%]")}>
                  {m.role === "assistant" && <AgentSteps invocations={invocations} active={stepsActive} />}
                  {isEditing ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); submitEdit(idx) }}
                      className="w-[min(36rem,80vw)] rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-900 p-2"
                    >
                      <label htmlFor={`edit-${m.id}`} className="sr-only">Edit message</label>
                      <textarea
                        id={`edit-${m.id}`}
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(idx) }
                          if (e.key === "Escape") setEditingId(null)
                        }}
                        rows={Math.min(8, Math.max(2, editText.split("\n").length))}
                        className="w-full resize-y bg-transparent text-sm p-1.5 focus:outline-none"
                      />
                      <div className="flex justify-end gap-2 mt-1">
                        <button type="button" onClick={() => setEditingId(null)} className="px-3 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-800">
                          Cancel
                        </button>
                        <button type="submit" disabled={!editText.trim() || isLoading} className="px-3 py-1.5 text-xs rounded-md bg-gray-900 dark:bg-white text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50">
                          Send
                        </button>
                      </div>
                    </form>
                  ) : shown ? (
                    <div className={cn(
                      "rounded-lg p-3.5 border text-sm",
                      m.role === "user"
                        ? "bg-gray-800 dark:bg-white text-white dark:text-black border-transparent"
                        : "bg-gray-100 dark:bg-gray-900/50 border-gray-300 dark:border-gray-800",
                    )}>
                      {m.role === "user" ? (
                        // Your own text, exactly as typed (no markdown parsing).
                        <p className="whitespace-pre-wrap break-words leading-relaxed">{shown}</p>
                      ) : (
                        <Markdown text={shown} />
                      )}
                    </div>
                  ) : null}
                  {/* Image attachments the user sent (shown in their own bubble) */}
                  {(m as any).experimental_attachments?.length > 0 && (
                    <div className={cn("mt-2 flex flex-wrap gap-2", m.role === "user" ? "justify-end" : "")}>
                      {(m as any).experimental_attachments
                        .filter((a: any) => a.contentType?.startsWith("image/"))
                        .map((a: any, i: number) => (
                          <figure key={i} className="flex flex-col items-end gap-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={a.url} alt={a.name || "Attached image"} className="max-h-40 rounded-lg border border-gray-300 dark:border-gray-700" />
                            <figcaption>
                              <a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:underline">
                                <Check className="w-3 h-3 text-green-600 dark:text-green-400" /> On IPFS <ArrowUpRight className="w-3 h-3" />
                              </a>
                            </figcaption>
                          </figure>
                        ))}
                    </div>
                  )}
                  {invocations.map((inv: any) =>
                    inv.state === "result" ? <ToolCard key={inv.toolCallId} callId={inv.toolCallId} result={inv.result} /> : null,
                  )}
                  {!isEditing && !stepsActive && (shown || canRegenerate) && (
                    <div className={cn("mt-1 flex items-center gap-0.5 transition-opacity", actionsVisibility)}>
                      {shown && <CopyAction text={shown} />}
                      {m.role === "user" && (
                        <MsgAction label="Edit message" disabled={isLoading} onClick={() => { setEditingId(m.id); setEditText(m.content) }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </MsgAction>
                      )}
                      {canRegenerate && (
                        <MsgAction label="Regenerate response" onClick={regenerate}>
                          <RotateCcw className="w-3.5 h-3.5" />
                        </MsgAction>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Failed request: the message is kept; offer a retry instead of losing it. */}
          {status === "error" && (
            <div className="flex items-start gap-3" role="alert">
              <div className="w-8 h-8 flex-shrink-0" />
              <div className="flex items-center gap-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                <span>Astrax couldn&apos;t reply{error?.message ? `: ${error.message.slice(0, 120)}` : "."}</span>
                <button type="button" onClick={() => reload()} className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                  <RotateCcw className="w-3.5 h-3.5" /> Retry
                </button>
              </div>
            </div>
          )}

          {/* Starter suggestions (only on a fresh conversation) */}
          {messages.length <= 1 && !isLoading && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 flex-shrink-0" />
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => append({ role: "user", content: s.prompt })}
                    className="inline-flex items-center gap-1.5 text-sm rounded-full border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-gray-600 dark:text-gray-300 hover:border-gray-500 dark:hover:border-gray-500 hover:text-black dark:hover:text-white transition-colors"
                  >
                    {s.icon} {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center">
                <Bot className="w-4 h-4" />
              </div>
              <div className="rounded-lg p-3.5 border border-gray-300 dark:border-gray-800 bg-gray-100 dark:bg-gray-900/50 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-4">
        {/* Picked images: thumbnail + live upload status */}
        {images.length > 0 && (
          <ul className="w-full mb-2 flex flex-wrap gap-2" aria-label="Attached images">
            {images.map((img) => (
              <li
                key={img.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-1.5 pr-2 text-xs max-w-xs",
                  img.status === "error"
                    ? "border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30"
                    : "border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-900",
                )}
              >
                <div className="relative w-10 h-10 flex-shrink-0 overflow-hidden rounded-md bg-gray-200 dark:bg-gray-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.preview} alt="" className={cn("w-full h-full object-cover", img.status === "uploading" && "opacity-50")} />
                  {img.status === "uploading" && (
                    <Loader2 className="absolute inset-0 m-auto w-4 h-4 animate-spin text-white" aria-hidden />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate font-medium" title={img.name}>{img.name}</div>
                  <div role="status" aria-live="polite">
                    {img.status === "uploading" && <span className="text-gray-500 dark:text-gray-400">Uploading to IPFS…</span>}
                    {img.status === "done" && (
                      <a href={img.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-green-700 dark:text-green-400 hover:underline">
                        <Check className="w-3 h-3" /> Uploaded to IPFS
                      </a>
                    )}
                    {img.status === "error" && <span className="text-red-700 dark:text-red-300 line-clamp-2">{img.error}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="ml-1 p-0.5 text-gray-500 hover:text-black dark:hover:text-white"
                  aria-label={`Remove ${img.name}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {(attachError || hasFailed) && (
          <p role="alert" className="mb-2 text-xs text-red-600 dark:text-red-400">
            {attachError || "Remove the image that failed before sending."}
          </p>
        )}
        <form onSubmit={onSubmit} className="w-full relative">
          <Input
            value={input}
            onChange={handleInputChange}
            placeholder={readyImages.length > 0 || uploading ? "Add a message, e.g. “mint this as an NFT called Sunset”" : "Message Astrax…"}
            disabled={isLoading}
            className="w-full bg-gray-100 dark:bg-gray-900 border-gray-300 dark:border-gray-700 pr-28 py-5 text-base rounded-lg"
          />
          <input ref={fileInputRef} type="file" multiple onChange={onPickFiles} className="hidden" accept={IMAGE_ACCEPT} aria-hidden tabIndex={-1} />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || images.length >= MAX_ATTACHMENTS}
              className="p-2 rounded-md text-gray-500 hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
              title={`Attach an image (${IMAGE_FORMATS_LABEL}, up to 10 MB)`}
              aria-label="Attach an image"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={toggleRecording}
              disabled={isLoading}
              className={cn("p-2 rounded-md transition-colors", isRecording ? "text-red-500 bg-red-50 dark:bg-red-950 animate-pulse" : "text-gray-500 hover:text-black dark:hover:text-white")}
              title={isRecording ? "Stop recording" : "Voice input"}
            >
              {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <Button type="submit" size="sm" disabled={!canSend} aria-label={uploading ? "Waiting for upload" : "Send"} className="bg-gray-800 dark:bg-white text-white dark:text-black hover:bg-gray-700 dark:hover:bg-gray-200">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
