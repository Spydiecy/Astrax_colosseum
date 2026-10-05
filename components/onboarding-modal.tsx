"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowLeftRight, ArrowUpRight, CalendarClock, Check, Link2, Lock, Rocket, Send,
  ShieldCheck, Wallet, X, Zap, type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface OnboardingModalProps {
  isOpen: boolean
  onClose: () => void
  /** Put an example prompt in the composer (the guide closes first). */
  onTryPrompt?: (prompt: string) => void
}

const CAPABILITIES: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Send, title: "Send", body: "SOL or any SPL token, to an address or a saved contact." },
  { icon: ArrowLeftRight, title: "Swap", body: "SOL, USDC and other devnet tokens through Raydium, with a live quote." },
  { icon: CalendarClock, title: "Schedule", body: "One-off or recurring payments that go out on their own." },
  { icon: Link2, title: "Get paid", body: "Payment links and Solana Pay QR codes that mark themselves paid." },
  { icon: Rocket, title: "Create", body: "Tokens with on-chain metadata, and NFTs from an image you upload." },
  { icon: ShieldCheck, title: "Explain", body: "Plain-English breakdowns of any transaction, wallet or token, with risk flags." },
]

const TRY_PROMPTS = [
  "What's my SOL balance?",
  "Swap 0.01 SOL to USDC",
  "Create a payment link for 0.5 SOL",
  "Pay alice 0.1 SOL every week, 4 times",
]

function ModeCard({
  icon: Icon, title, tag, summary, points,
}: { icon: LucideIcon; title: string; tag: string; summary: string; points: string[] }) {
  return (
    <div className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-base font-semibold text-black dark:text-white">
          <Icon className="w-5 h-5" aria-hidden /> {title}
        </div>
        <span className="rounded border border-gray-200 dark:border-gray-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {tag}
        </span>
      </div>
      <p className="mt-3 text-[15px] text-gray-600 dark:text-gray-300">{summary}</p>
      <ul className="mt-4 space-y-2">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Check className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
            {p}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function OnboardingModal({ isOpen, onClose, onTryPrompt }: OnboardingModalProps) {
  const [step, setStep] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)

  const steps: { nav: string; title: string; description: string; body: React.ReactNode }[] = [
    {
      nav: "What it does",
      title: "Use Solana by describing what you want",
      description: "Astrax picks the right on-chain action and shows you exactly what it will do before anything is sent.",
      body: (
        <>
          <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="flex w-10 h-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300">
                  <Icon className="w-5 h-5" aria-hidden />
                </span>
                <span>
                  <span className="block text-base font-medium text-black dark:text-white">{title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-gray-500 dark:text-gray-400">{body}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-7 text-sm text-gray-500 dark:text-gray-400">
            Also available: price charts, recent blocks, diagrams and a private address book.
          </p>
        </>
      ),
    },
    {
      nav: "Signing",
      title: "Choose how transactions are signed",
      description: "You can switch at any time in the Signing panel in the sidebar.",
      body: (
        <div className="grid gap-4 sm:grid-cols-2">
          <ModeCard
            icon={Wallet}
            title="Wallet"
            tag="Recommended"
            summary="Connect Phantom, Solflare, Backpack or any Solana wallet."
            points={[
              "Astrax prepares each transaction",
              "You review and approve it in your wallet",
              "Your keys never leave the wallet",
            ]}
          />
          <ModeCard
            icon={Zap}
            title="Autonomous"
            tag="Devnet only"
            summary="Paste a devnet secret key and Astrax signs for you."
            points={[
              "Transactions are sent straight away",
              "Required for scheduled payments",
              "The key stays in this browser; for schedules it's stored encrypted and deleted when they finish",
            ]}
          />
        </div>
      ),
    },
    {
      nav: "Get started",
      title: "Make your first transaction",
      description: "Astrax runs on Solana devnet, so everything uses free test SOL.",
      body: (
        <>
          <ol className="space-y-6">
            <li className="flex gap-3">
              <span className="flex w-7 h-7 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 dark:border-gray-700 text-sm font-medium">1</span>
              <div className="text-base">
                <div className="font-medium text-black dark:text-white">Get devnet SOL</div>
                <a
                  href="https://faucet.solana.com"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 underline-offset-2 hover:text-black dark:hover:text-white hover:underline"
                >
                  Free from the Solana faucet <ArrowUpRight className="w-3 h-3" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex w-7 h-7 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 dark:border-gray-700 text-sm font-medium">2</span>
              <div className="text-base">
                <div className="font-medium text-black dark:text-white">Connect a wallet or add a key</div>
                <div className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">Use Connect Wallet at the top right, or the Signing panel in the sidebar.</div>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex w-7 h-7 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 dark:border-gray-700 text-sm font-medium">3</span>
              <div className="min-w-0 text-base">
                <div className="font-medium text-black dark:text-white">Ask Astrax</div>
                <div className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                  {onTryPrompt ? "Pick one to start, or type your own." : "For example:"}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {TRY_PROMPTS.map((p) =>
                    onTryPrompt ? (
                      <button
                        key={p}
                        type="button"
                        onClick={() => onTryPrompt(p)}
                        className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-600 hover:text-black dark:hover:text-white transition-colors"
                      >
                        {p}
                      </button>
                    ) : (
                      <span key={p} className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300">{p}</span>
                    ),
                  )}
                </div>
              </div>
            </li>
          </ol>
          <p className="mt-8 flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
            Chats are saved only in this browser. Clearing site data or using a private window deletes them.
          </p>
        </>
      ),
    },
  ]

  const last = steps.length - 1
  const current = steps[step]

  // Start from the first step each time the guide opens.
  useEffect(() => {
    if (isOpen) setStep(0)
  }, [isOpen])

  // Move focus into the dialog when it opens and onto the main button per step.
  useEffect(() => {
    if (isOpen) primaryRef.current?.focus()
  }, [isOpen, step])

  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== "Tab" || !dialogRef.current) return
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const lastEl = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-description"
        className="relative grid w-full max-w-5xl max-h-[calc(100vh-2rem)] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-black text-black dark:text-white shadow-xl md:h-[min(40rem,calc(100vh-2rem))] md:grid-cols-[16rem_1fr]"
      >
        {/* Step navigation */}
        <aside className="hidden md:flex flex-col border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 p-6">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="w-7 h-7 rounded" />
            <span className="text-base font-semibold">Astrax</span>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Getting started</p>
          <nav aria-label="Guide steps" className="mt-8">
            <ol className="space-y-1">
              {steps.map((s, i) => (
                <li key={s.nav}>
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-current={i === step ? "step" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[15px] transition-colors",
                      i === step
                        ? "bg-white dark:bg-gray-900 font-medium text-black dark:text-white shadow-sm"
                        : "text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white",
                    )}
                  >
                    <span
                      className={cn(
                        "flex w-6 h-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                        i < step
                          ? "border-black dark:border-white bg-black dark:bg-white text-white dark:text-black"
                          : i === step
                            ? "border-black dark:border-white"
                            : "border-gray-300 dark:border-gray-700",
                      )}
                    >
                      {i < step ? <Check className="w-3 h-3" aria-hidden /> : i + 1}
                    </span>
                    {s.nav}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <p className="mt-auto pt-6 text-sm text-gray-500 dark:text-gray-400">
            Open this guide again any time from <span className="font-medium text-gray-700 dark:text-gray-300">How it works</span>.
          </p>
        </aside>

        {/* Content */}
        <section className="flex min-h-0 flex-col">
          <header className="flex items-start justify-between gap-4 px-8 pt-8">
            <div>
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Step {step + 1} of {steps.length}</p>
              <h2 id="onboarding-title" className="mt-1.5 text-2xl font-semibold tracking-tight">{current.title}</h2>
              <p id="onboarding-description" className="mt-2 max-w-2xl text-base text-gray-500 dark:text-gray-400">{current.description}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 -mt-1 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-900 hover:text-black dark:hover:text-white transition-colors"
              aria-label="Close guide"
            >
              <X className="w-5 h-5" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">{current.body}</div>

          <footer className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-800 px-8 py-5">
            <div className="flex items-center gap-1.5" aria-hidden>
              {steps.map((s, i) => (
                <span
                  key={s.nav}
                  className={cn("h-1 w-8 rounded-full transition-colors", i <= step ? "bg-black dark:bg-white" : "bg-gray-200 dark:bg-gray-800")}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              {step === 0 ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-4 py-2.5 text-sm text-gray-500 hover:text-black dark:hover:text-white transition-colors"
                >
                  Skip
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="rounded-md border border-gray-200 dark:border-gray-800 px-4 py-2.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                >
                  Back
                </button>
              )}
              <button
                ref={primaryRef}
                type="button"
                onClick={() => (step === last ? onClose() : setStep((s) => Math.min(last, s + 1)))}
                className="rounded-md bg-black dark:bg-white px-5 py-2.5 text-sm font-medium text-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
              >
                {step === last ? "Start chatting" : "Continue"}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}
