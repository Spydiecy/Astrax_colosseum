import { MessageSquare, Bot, Wallet, Blocks, Database, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// The actual stack Astrax runs on, top (what you touch) to bottom (where data lives).
// Keep in sync with package.json.
const LAYERS: { icon: LucideIcon; label: string; detail: string; items: string[] }[] = [
  {
    icon: MessageSquare,
    label: "Interface",
    detail: "Chat, cards and pay pages",
    items: ["Next.js 15", "React 19", "Tailwind CSS 4", "TypeScript"],
  },
  {
    icon: Bot,
    label: "Agent",
    detail: "Streams replies and calls typed tools",
    items: ["Vercel AI SDK", "Mistral ministral-8b", "Zod tools"],
  },
  {
    icon: Wallet,
    label: "Wallets",
    detail: "Approve in your wallet, or sign autonomously",
    items: ["Solana Wallet Adapter", "Wallet Standard", "Sign-in with Solana"],
  },
  {
    icon: Blocks,
    label: "Chain",
    detail: "Transfers, swaps, tokens, NFTs and payment tracking",
    items: ["@solana/web3.js", "SPL Token & Token-2022", "Solana Pay", "Raydium Trade API"],
  },
  {
    icon: Database,
    label: "Storage",
    detail: "Per-wallet data, files and private chats",
    items: ["libSQL / Turso", "Pinata IPFS", "Browser storage"],
  },
]

export function TechStack({ className }: { className?: string }) {
  return (
    <figure className={cn("relative", className)} aria-label="Astrax technology stack">
      {/* connecting spine */}
      <div aria-hidden className="absolute left-[2.125rem] top-8 bottom-8 w-px bg-gradient-to-b from-transparent via-border to-transparent" />
      <ol className="relative space-y-3">
        {LAYERS.map(({ icon: Icon, label, detail, items }, i) => (
          <li
            key={label}
            className="relative flex gap-4 rounded-xl border bg-card/60 p-4 backdrop-blur-sm transition-colors hover:border-primary/40"
            style={{ marginLeft: `${i * 0.5}rem`, marginRight: `${(LAYERS.length - 1 - i) * 0.5}rem` }}
          >
            <div className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
              <Icon className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-xs text-muted-foreground">{detail}</span>
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {items.map((item) => (
                  <li key={item} className="rounded-md border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground/80">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
      <figcaption className="sr-only">
        {LAYERS.map((l) => `${l.label}: ${l.items.join(", ")}`).join(". ")}
      </figcaption>
    </figure>
  )
}
