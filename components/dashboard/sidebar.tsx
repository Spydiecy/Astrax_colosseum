"use client"

import Link from "next/link"
import { useState, useEffect, useCallback } from "react"
import { useTheme } from "next-themes"
import {
  Plus, FileText, ArrowLeft, ChevronLeft, ChevronDown, Key, Wallet, Zap, Eye, EyeOff, Check,
  MessageSquare, Trash2, CalendarClock, Link2, Pencil, Lock, BookUser,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useCredentials } from "@/contexts/CredentialsContext"
import { ScheduledModal } from "@/components/scheduled-modal"
import { PaymentLinksModal } from "@/components/payment-links-modal"
import { ContactsModal } from "@/components/contacts-modal"
import { getChats, getCurrentId, newChat, openChat, deleteChat, renameChat, MAX_TITLE, type ChatMeta } from "@/lib/chat-history"

interface DashboardSidebarProps {
  open: boolean
  setOpen: (open: boolean) => void
}

const short = (a?: string | null) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "")

export function DashboardSidebar({ open, setOpen }: DashboardSidebarProps) {
  const { resolvedTheme } = useTheme()
  const { privateKey, setPrivateKey, derivedAddress, hasPrivateKey, signingMode, setSigningMode } = useCredentials()
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [scheduledOpen, setScheduledOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(false)
  const [contactsOpen, setContactsOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState("")

  const refresh = useCallback(() => {
    setChats(getChats())
    setCurrentId(getCurrentId())
  }, [])

  useEffect(() => {
    setMounted(true)
    refresh()
    const onChats = () => refresh()
    window.addEventListener("astrax:chats", onChats)
    window.addEventListener("astrax:chat-open", onChats)
    return () => {
      window.removeEventListener("astrax:chats", onChats)
      window.removeEventListener("astrax:chat-open", onChats)
    }
  }, [refresh])

  if (!mounted) return null

  const isDark = resolvedTheme !== "light"

  const handleNewChat = () => {
    const id = newChat()
    openChat(id)
    refresh()
  }

  const handleOpenChat = (id: string) => {
    openChat(id)
    setCurrentId(id)
  }

  const startRename = (c: ChatMeta) => {
    setRenamingId(c.id)
    setRenameText(c.title)
  }

  const commitRename = () => {
    if (!renamingId) return
    const original = chats.find((c) => c.id === renamingId)?.title
    if (renameText.trim() !== original) renameChat(renamingId, renameText)
    setRenamingId(null)
    refresh()
  }

  const handleDeleteChat = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const title = chats.find((c) => c.id === id)?.title || "this chat"
    if (!window.confirm(`Delete "${title}"? Chats are only stored in this browser, so this can't be undone.`)) return
    deleteChat(id)
    if (currentId === id) handleNewChat()
    else refresh()
  }

  const statusColor = signingMode === "auto" ? (hasPrivateKey ? "bg-green-500" : "bg-red-500") : "bg-blue-500"
  const statusLabel = signingMode === "auto" ? (hasPrivateKey ? "Autonomous · key loaded" : "Autonomous · add a key") : "Wallet signing"

  const ModeButton = ({ mode, icon, label }: { mode: "wallet" | "auto"; icon: React.ReactNode; label: string }) => (
    <button
      onClick={() => setSigningMode(mode)}
      className={cn(
        "flex-1 flex flex-col items-center gap-1 py-2.5 rounded-md border text-xs font-medium transition-colors",
        signingMode === mode
          ? isDark ? "bg-white text-black border-white" : "bg-black text-white border-black"
          : isDark ? "border-gray-700 text-gray-400 hover:bg-gray-900" : "border-gray-300 text-gray-600 hover:bg-gray-100",
      )}
    >
      {icon}
      {label}
    </button>
  )

  const navBtn = (active: boolean) =>
    cn(
      "flex items-center px-3 py-2.5 text-sm rounded-lg transition-colors cursor-pointer w-full group relative",
      active
        ? isDark ? "bg-gray-800 text-white" : "bg-gray-200 text-black"
        : isDark ? "text-gray-400 hover:bg-gray-800 hover:text-white" : "text-gray-600 hover:bg-gray-200 hover:text-black",
    )

  return (
    <>
      <ScheduledModal isOpen={scheduledOpen} onClose={() => setScheduledOpen(false)} />
      <PaymentLinksModal isOpen={linksOpen} onClose={() => setLinksOpen(false)} />
      <ContactsModal isOpen={contactsOpen} onClose={() => setContactsOpen(false)} />
      <div
        className={cn(
          "fixed left-0 top-0 h-full border-r flex flex-col transition-all duration-300 z-30",
          isDark ? "bg-black border-gray-800 text-white" : "bg-white border-gray-300 text-black",
          open ? "w-64" : "w-20",
        )}
      >
        {/* Header */}
        <div className={cn("flex items-center justify-between px-4 h-16 border-b flex-shrink-0", isDark ? "border-gray-800" : "border-gray-300")}>
          <div className={cn("flex items-center", !open && "hidden")}>
            <span className={cn("text-xl font-bold", isDark ? "text-white" : "text-black")}>Astrax</span>
            <span className={cn("text-xs ml-2 px-2 py-1 rounded", isDark ? "bg-gray-800 text-gray-300" : "bg-gray-200 text-gray-700")}>beta</span>
          </div>
          <button onClick={() => setOpen(!open)} className={cn("p-2 rounded-lg transition-colors", isDark ? "hover:bg-gray-800" : "hover:bg-gray-200")}>
            <ChevronLeft className={cn("h-6 w-6 transition-transform", isDark ? "text-gray-400" : "text-gray-600", !open && "rotate-180")} />
          </button>
        </div>

        {/* New Chat */}
        <div className={cn("p-3 flex-shrink-0", !open && "px-2")}>
          <button
            onClick={handleNewChat}
            className={cn(
              "flex items-center justify-center gap-2 px-3 py-2.5 text-sm rounded-lg w-full border transition-colors",
              isDark ? "border-gray-700 hover:bg-gray-900 text-white" : "border-gray-300 hover:bg-gray-100 text-black",
            )}
          >
            <Plus className="h-4 w-4" />
            {open && <span>New Chat</span>}
          </button>
        </div>

        {/* Chat history */}
        {open && (
          <div className="flex-1 overflow-y-auto px-2 min-h-0">
            {chats.length > 0 && <div className="px-2 py-1 text-xs text-gray-400 uppercase tracking-wide">Chats</div>}
            {chats.map((c) =>
              renamingId === c.id ? (
                <form
                  key={c.id}
                  onSubmit={(e) => { e.preventDefault(); commitRename() }}
                  className={cn(navBtn(true), "cursor-default")}
                >
                  <MessageSquare className="h-4 w-4 flex-shrink-0" />
                  <label htmlFor={`rename-${c.id}`} className="sr-only">Chat name</label>
                  <input
                    id={`rename-${c.id}`}
                    autoFocus
                    value={renameText}
                    maxLength={MAX_TITLE}
                    onChange={(e) => setRenameText(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setRenamingId(null) } }}
                    onBlur={commitRename}
                    className={cn(
                      "ml-2 flex-1 min-w-0 bg-transparent text-sm rounded px-1 -mx-1 outline-none ring-1",
                      isDark ? "ring-gray-600 focus:ring-white" : "ring-gray-400 focus:ring-black",
                    )}
                  />
                </form>
              ) : (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenChat(c.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpenChat(c.id) }
                    if (e.key === "F2") { e.preventDefault(); startRename(c) }
                  }}
                  onDoubleClick={() => startRename(c)}
                  title={c.title}
                  aria-current={c.id === currentId ? "true" : undefined}
                  className={navBtn(c.id === currentId)}
                >
                  <MessageSquare className="h-4 w-4 flex-shrink-0" />
                  <span className="ml-2 truncate flex-1">{c.title}</span>
                  <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); startRename(c) }}
                      aria-label={`Rename chat "${c.title}"`}
                      title="Rename"
                      className="text-gray-500 hover:text-black dark:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 rounded"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteChat(e, c.id)}
                      aria-label={`Delete chat "${c.title}"`}
                      title="Delete"
                      className="text-gray-500 hover:text-red-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              ),
            )}
            {chats.length > 0 && (
              <p className="px-2 pt-3 pb-2 text-[11px] leading-snug text-gray-500">
                <Lock className="inline h-3 w-3 mr-1 -mt-0.5" aria-hidden />
                Chats are saved only in this browser, for privacy. Clearing site data or browsing privately deletes them, and they don&apos;t sync to other devices.
              </p>
            )}
          </div>
        )}
        {!open && <div className="flex-1" />}

        {/* Scheduled + Docs */}
        <div className={cn("p-2 border-t flex-shrink-0 space-y-1", isDark ? "border-gray-800" : "border-gray-300")}>
          <button onClick={() => setScheduledOpen(true)} className={navBtn(false)}>
            <CalendarClock className="h-4 w-4 flex-shrink-0" />
            {open && <span className="ml-2">Scheduled</span>}
          </button>
          <button onClick={() => setLinksOpen(true)} className={navBtn(false)}>
            <Link2 className="h-4 w-4 flex-shrink-0" />
            {open && <span className="ml-2">Payment links</span>}
          </button>
          <button onClick={() => setContactsOpen(true)} className={navBtn(false)}>
            <BookUser className="h-4 w-4 flex-shrink-0" />
            {open && <span className="ml-2">Contacts</span>}
          </button>
          <a href="https://github.com/Spydiecy/Astrax_colosseum#readme" target="_blank" rel="noopener noreferrer" className={navBtn(false)}>
            <FileText className="h-4 w-4 flex-shrink-0" />
            {open && <span className="ml-2">Docs</span>}
          </a>
        </div>

        {/* Signing panel */}
        <div className={cn("p-3 border-t flex-shrink-0", isDark ? "border-gray-800" : "border-gray-300", !open && "px-2")}>
          {open ? (
            <div className="space-y-3">
              <button onClick={() => setShowPanel(!showPanel)} className={cn("flex items-center justify-between w-full px-3 py-2.5 text-sm rounded-lg transition-colors", isDark ? "text-gray-400 hover:bg-gray-800 hover:text-white" : "text-gray-600 hover:bg-gray-200 hover:text-black")}>
                <div className="flex items-center space-x-3"><Zap className="h-5 w-5" /><span className="font-medium">Signing</span></div>
                <ChevronDown className={cn("h-4 w-4 transition-transform", showPanel && "rotate-180")} />
              </button>
              <div className="flex items-center space-x-2 px-3">
                <div className={cn("w-2 h-2 rounded-full", statusColor)} />
                <span className={cn("text-xs", isDark ? "text-gray-400" : "text-gray-600")}>{statusLabel}</span>
              </div>
              {showPanel && (
                <div className="space-y-3 px-3">
                  <div className="flex gap-2">
                    <ModeButton mode="wallet" icon={<Wallet className="h-4 w-4" />} label="Wallet" />
                    <ModeButton mode="auto" icon={<Zap className="h-4 w-4" />} label="Autonomous" />
                  </div>
                  {signingMode === "wallet" ? (
                    <p className={cn("text-xs leading-relaxed", isDark ? "text-gray-400" : "text-gray-600")}>
                      Connect your wallet in the top bar. Astrax prepares each transaction and you approve it with a one-click button.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <label className={cn("text-xs flex items-center space-x-1", isDark ? "text-gray-400" : "text-gray-600")}>
                        <Key className="h-3 w-3" /><span>Secret Key</span>
                      </label>
                      <div className="relative">
                        <input
                          type={showPrivateKey ? "text" : "password"}
                          value={privateKey}
                          onChange={(e) => setPrivateKey(e.target.value)}
                          placeholder="base58 secret key (never leaves your request)"
                          className={cn("w-full px-3 py-2 pr-10 border rounded-md text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:border-transparent", isDark ? "bg-gray-900 border-gray-700 text-white focus:ring-white" : "bg-gray-100 border-gray-300 text-black focus:ring-gray-500")}
                        />
                        <button type="button" onClick={() => setShowPrivateKey(!showPrivateKey)} className={cn("absolute right-3 top-1/2 -translate-y-1/2", isDark ? "text-gray-400 hover:text-white" : "text-gray-600 hover:text-black")}>
                          {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {privateKey && !derivedAddress && <p className="text-xs text-red-500">That doesn&apos;t look like a valid secret key.</p>}
                      {derivedAddress && (
                        <div className={cn("flex items-center gap-2 text-xs rounded-md px-2 py-1.5", isDark ? "bg-gray-900 text-gray-300" : "bg-gray-100 text-gray-700")}>
                          <Check className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                          <span className="font-mono">{short(derivedAddress)}</span>
                          <span className="opacity-60">auto-derived</span>
                        </div>
                      )}
                      <p className={cn("text-xs leading-relaxed", isDark ? "text-gray-500" : "text-gray-500")}>
                        Devnet only. Used server-side to sign; for scheduled payments it&apos;s stored encrypted so they can run later.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex justify-center py-2"><div className={cn("w-4 h-4 rounded-full", statusColor)} /></div>
          )}
        </div>

        {/* Back to Home */}
        <div className={cn("p-3 border-t flex-shrink-0", isDark ? "border-gray-800" : "border-gray-300", !open && "px-2")}>
          <Link href="/" className={navBtn(false)}>
            <ArrowLeft className="h-4 w-4 flex-shrink-0" />
            {open && <span className="ml-2">Back to Home</span>}
          </Link>
        </div>
      </div>
    </>
  )
}
