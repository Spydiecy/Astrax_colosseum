"use client"

import { useCallback, useEffect, useState } from "react"
import { useCredentials } from "@/contexts/CredentialsContext"
import { useConnection, useWallet } from "@solana/wallet-adapter-react"
import { VersionedTransaction, type Keypair, type Transaction } from "@solana/web3.js"
import { Loader2, Zap, CheckCircle2, ArrowUpRight } from "lucide-react"
import { explorerTx } from "@/lib/solana"
import { buildCreateToken, deserializeTx } from "@/lib/spl"

export interface PendingAction {
  action: "sendNative" | "sendToken" | "deployToken" | "deployNFT" | "mintTokens" | "swap"
  label: string
  /** Server-prepared transaction (transfers / mint-to). Absent for create actions. */
  txBase64?: string
  /** Server-prepared versioned transactions for a swap, signed in order. */
  txsBase64?: string[]
  to?: string
  mint?: string
  symbol?: string
  amount?: string
  // Create-token / NFT params — the tx is built in the browser so the fresh
  // mint keypair can co-sign without ever leaving this page.
  name?: string
  supply?: string
  decimals?: number
  uri?: string
  fixedSupply?: boolean
  metadataUri?: string
  image?: string
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "")

// Confirmed actions are remembered per tool call, so a reloaded chat shows
// "Confirmed" instead of offering to pay again.
const doneKey = (id: string) => `astrax_tx_done:${id}`
interface DoneRecord { signature: string; mint?: string }

export function TxActionButton({ id, action, onDone }: { id?: string; action: PendingAction; onDone?: (sig: string) => void }) {
  const { connection } = useConnection()
  const { publicKey, sendTransaction, connected } = useWallet()
  const { signingMode } = useCredentials()
  const [signature, setSignature] = useState<string>()
  const [createdMint, setCreatedMint] = useState<string>()
  const [phase, setPhase] = useState<"idle" | "wallet" | "mining" | "done" | "error">("idle")
  const [errMsg, setErrMsg] = useState("")

  useEffect(() => {
    if (!id) return
    try {
      const rec = JSON.parse(localStorage.getItem(doneKey(id)) || "null") as DoneRecord | null
      if (rec?.signature) {
        setSignature(rec.signature)
        setCreatedMint(rec.mint)
        setPhase("done")
      }
    } catch {
      /* ignore corrupt entries */
    }
  }, [id])

  const execute = useCallback(async () => {
    if (!connected || !publicKey) {
      setErrMsg("Connect your wallet first.")
      setPhase("error")
      return
    }
    setPhase("wallet")
    setErrMsg("")
    try {
      // Swaps: Raydium-built versioned transactions (checked on the server), sent in order.
      if (action.action === "swap") {
        const list = action.txsBase64 ?? []
        if (list.length === 0) throw new Error("Missing prepared swap transaction")
        let last = ""
        for (const b64 of list) {
          const vtx = VersionedTransaction.deserialize(b64ToBytes(b64))
          if (!vtx.message.staticAccountKeys[0]?.equals(publicKey)) {
            throw new Error("This swap was prepared for a different wallet. Ask Astrax again with this wallet connected.")
          }
          // Fresh blockhash so a card that sat for a while still lands.
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed")
          vtx.message.recentBlockhash = blockhash
          setPhase("wallet")
          const sig = await sendTransaction(vtx, connection)
          setSignature(sig)
          setPhase("mining")
          const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
          if (res.value.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(res.value.err)}`)
          last = sig
        }
        if (id) localStorage.setItem(doneKey(id), JSON.stringify({ signature: last } satisfies DoneRecord))
        setPhase("done")
        onDone?.(last)
        return
      }

      let tx: Transaction
      let mintAddr: string | undefined
      const signers: Keypair[] = []
      if (action.action === "deployToken" || action.action === "deployNFT") {
        const built = await buildCreateToken(connection, publicKey, {
          name: action.name || "Token",
          symbol: action.symbol || "TKN",
          uri: action.uri || "",
          decimals: action.decimals ?? 9,
          supply: action.supply || "0",
          fixedSupply: action.fixedSupply,
        })
        tx = built.tx
        signers.push(built.mint)
        mintAddr = built.mint.publicKey.toBase58()
        setCreatedMint(mintAddr)
      } else {
        if (!action.txBase64) throw new Error("Missing prepared transaction")
        tx = deserializeTx(action.txBase64)
        if (tx.feePayer && !tx.feePayer.equals(publicKey)) {
          throw new Error("This transaction was prepared for a different wallet. Ask Astrax again with this wallet connected.")
        }
      }
      // Fresh blockhash so a card that sat for a while still confirms.
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized")
      tx.recentBlockhash = blockhash
      tx.feePayer = publicKey
      const sig = await sendTransaction(tx, connection, { signers })
      setSignature(sig)
      setPhase("mining")
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
      if (res.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`)
      if (id) localStorage.setItem(doneKey(id), JSON.stringify({ signature: sig, mint: mintAddr } satisfies DoneRecord))
      setPhase("done")
      onDone?.(sig)
    } catch (e: any) {
      setErrMsg((e?.message || "Transaction rejected").slice(0, 160))
      setPhase("error")
    }
  }, [id, action, connection, publicKey, sendTransaction, connected, onDone])

  // NFT artwork + links to the IPFS image and metadata, shown before and after confirming.
  const nftPreview = action.action === "deployNFT" && action.image ? (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={action.image} alt={`${action.name || "NFT"} artwork`} className="w-20 h-20 rounded-md object-cover flex-shrink-0 bg-gray-100 dark:bg-gray-900" />
      <div className="min-w-0 text-xs">
        <div className="text-sm font-medium truncate">{action.name}{action.symbol ? ` (${action.symbol})` : ""}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <a href={action.image} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
            Image on IPFS <ArrowUpRight className="w-3 h-3" />
          </a>
          {action.metadataUri && (
            <a href={action.metadataUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline">
              Metadata JSON <ArrowUpRight className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  ) : null

  if (phase === "done") {
    return (
      <div className="w-full max-w-xl">
      {nftPreview}
      <div className="mt-3 w-full rounded-lg border border-green-300 dark:border-green-900/60 bg-green-50 dark:bg-green-950/30 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300">
          <CheckCircle2 className="w-4 h-4" /> Confirmed
        </div>
        {createdMint && (
          <div className="mt-1 text-xs font-mono text-green-700 dark:text-green-300 break-all">Mint: {createdMint}</div>
        )}
        {signature && (
          <a href={explorerTx(signature)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-300 hover:underline">
            View on Solana Explorer ({short(signature)}) <ArrowUpRight className="w-3 h-3" />
          </a>
        )}
      </div>
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div className="mt-3 w-full max-w-xl rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-3">
        <span className="break-all">{errMsg}</span>
        <button onClick={() => setPhase("idle")} className="underline flex-shrink-0 text-xs">retry</button>
      </div>
    )
  }

  // Autonomous mode signs server-side, so wallet confirm buttons don't apply.
  // (Only reachable for an action prepared earlier, before switching modes.)
  if (signingMode === "auto" && phase === "idle") {
    return (
      <div className="mt-3 w-full max-w-xl rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400">
        {action.label} — prepared in wallet mode and not sent. Switch to <strong>Wallet</strong> signing to confirm it, or ask again to run it autonomously.
      </div>
    )
  }

  const busy = phase === "wallet" || phase === "mining"
  return (
    <div className="w-full max-w-xl">
    {nftPreview}
    {action.to && (
      <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2 text-xs">
        <div className="text-gray-500 dark:text-gray-400">{action.action === "mintTokens" ? "Mint to" : "Recipient"}</div>
        <div className="font-mono break-all mt-0.5">{action.to}</div>
      </div>
    )}
    <button
      onClick={execute}
      disabled={busy}
      className="mt-2 w-full flex items-center justify-center gap-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-black px-4 py-3 text-sm font-semibold hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-70 transition-colors"
    >
      {phase === "mining" ? (
        <><Loader2 className="w-4 h-4 animate-spin" /> Confirming on-chain…</>
      ) : phase === "wallet" ? (
        <><Loader2 className="w-4 h-4 animate-spin" /> Confirm in wallet…</>
      ) : (
        <><Zap className="w-4 h-4" /> {action.label}</>
      )}
    </button>
    </div>
  )
}
