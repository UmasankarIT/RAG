'use client'

// Teaching bot chat UI — talks to the 3H Pedagogical Agent's Mode 3 (TEACH).
// Backend contract: POST /api/teach { learnerExtKey, topic }
// Response: { ok: true, data: { answer, citations, unknownCitations, usedVisual, ... } }
//        or { ok: false, error }
// See src/server.ts for the route and src/modes/teach.ts for what it teaches from.

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  BotMessageSquare,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const BOT_API_URL = '/api/teach'

const CHAT_KEY = 'ai-tutor-chat-v2'
const LEARNER_KEY = 'ai-tutor-learner-id'

interface BotReply {
  answer: string
  citations: string[]
  unknownCitations: string[]
  usedVisual: boolean
}

interface BotMsg {
  id: string
  role: 'user' | 'bot'
  text: string
  citations?: string[]
  usedVisual?: boolean
  pending?: boolean
  error?: string
}

type FetchResult = { ok: true; data: BotReply } | { ok: false; error: string }

async function fetchAiReply(learnerExtKey: string, topic: string): Promise<FetchResult> {
  try {
    const res = await fetch(BOT_API_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learnerExtKey, topic }),
    })
    const body = (await res.json().catch(() => null)) as
      | { ok: boolean; data?: BotReply; error?: unknown }
      | null
    if (!res.ok || !body || !body.ok || !body.data) {
      const detail =
        typeof body?.error === 'string' ? body.error : `request failed (${res.status})`
      return { ok: false, error: detail }
    }
    return { ok: true, data: body.data }
  } catch {
    return { ok: false, error: 'could not reach the backend — is the server running?' }
  }
}

function uid() {
  return Math.random().toString(36).slice(2)
}

function learnerId(): string {
  let id = localStorage.getItem(LEARNER_KEY)
  if (!id) {
    id = `web-${uid()}`
    localStorage.setItem(LEARNER_KEY, id)
  }
  return id
}

const GREETING: BotMsg = {
  id: 'greeting',
  role: 'bot',
  text: "Ask me about a topic and I'll teach it from the reviewed knowledge nodes, citing each claim as I go.",
}

export function TeachingBot({ heightClass = 'h-[calc(100dvh-9.5rem)]' }: { heightClass?: string }) {
  const [messages, setMessages] = useState<BotMsg[]>([GREETING])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as BotMsg[]
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed)
      }
    } catch {
      /* fine */
    }
  }, [])

  useEffect(() => {
    const settled = messages.filter((m) => !m.pending)
    if (settled.length > 1) {
      try {
        localStorage.setItem(CHAT_KEY, JSON.stringify(settled))
      } catch {
        /* fine */
      }
    }
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const clearHistory = () => {
    setMessages([GREETING])
    try {
      localStorage.removeItem(CHAT_KEY)
    } catch {
      /* fine */
    }
    setShowSettings(false)
  }

  const sendMessage = async () => {
    const topic = input.trim()
    if (!topic || sending) return
    setInput('')
    setSending(true)

    const userMsg: BotMsg = { id: uid(), role: 'user', text: topic }
    const botId = uid()
    setMessages((prev) => [...prev, userMsg, { id: botId, role: 'bot', text: '', pending: true }])

    const result = await fetchAiReply(learnerId(), topic)

    setMessages((prev) =>
      prev.map((m) =>
        m.id === botId
          ? result.ok
            ? {
                id: botId,
                role: 'bot',
                text: result.data.answer,
                citations: result.data.citations,
                usedVisual: result.data.usedVisual,
              }
            : { id: botId, role: 'bot', text: '', error: result.error }
          : m,
      ),
    )
    setSending(false)
  }

  return (
    <div className={cn('mx-auto flex max-w-3xl flex-col', heightClass)}>
      {/* Header */}
      <div className="flex items-center justify-between pb-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-linear-to-br from-teal-500 to-emerald-600 shadow-md">
            <BotMessageSquare className="size-5 text-white" />
          </div>
          <div>
            <div className="text-[16px] font-bold tracking-tight">AI Tutor</div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
              Mode 3 · Teach
            </div>
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="grid size-9 place-items-center rounded-full border border-border/60 bg-background/60 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <Settings className="size-4" />
          </button>
          {showSettings && (
            <div className="absolute right-0 top-11 z-20 w-52 overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-lg">
              <div className="border-b border-border/60 px-4 py-2.5 text-[11.5px] font-semibold text-muted-foreground">
                Bot Settings
              </div>
              <button
                type="button"
                onClick={clearHistory}
                className="flex w-full items-center gap-2 px-4 py-3 text-[12.5px] text-rose-600 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
              >
                <Trash2 className="size-4" />
                Clear chat history
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1">
        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex flex-col gap-2', msg.role === 'user' && 'items-end')}>
            {msg.role === 'user' ? (
              <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-slate-700 px-4 py-2.5 text-[13px] text-white">
                {msg.text}
              </div>
            ) : (
              <div className="flex items-start gap-2.5 max-w-full">
                <div className="grid size-7 shrink-0 place-items-center rounded-full bg-linear-to-br from-teal-500 to-emerald-600 mt-1">
                  <Sparkles className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  {msg.pending ? (
                    <div
                      className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5"
                      aria-label="Assistant is typing"
                    >
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50" />
                    </div>
                  ) : msg.error ? (
                    <div className="flex items-start gap-2 rounded-2xl rounded-tl-sm border border-rose-200 bg-rose-50 px-4 py-3 text-[12.5px] text-rose-700">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {msg.error}
                    </div>
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 text-[13px] leading-relaxed">
                        {msg.text}
                      </div>
                      {(msg.citations?.length || msg.usedVisual !== undefined) && (
                        <div className="flex flex-wrap items-center gap-1.5 px-1 text-[10.5px] text-muted-foreground">
                          {msg.citations?.map((c) => (
                            <span
                              key={c}
                              className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 font-mono text-teal-700"
                            >
                              <BookOpen className="size-2.5" />
                              {c}
                            </span>
                          ))}
                          {msg.usedVisual !== undefined && (
                            <span className="opacity-70">
                              {msg.usedVisual ? 'visual retrieval' : 'lexical retrieval'}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Input bar */}
      <div className="pt-3 pb-1 border-t border-border/60">
        <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/80 pl-4 pr-2 py-1.5 shadow-sm focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-400/20">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder="Ask about a topic…"
            className="flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            className="grid size-9 place-items-center rounded-xl bg-slate-700 text-white transition-colors hover:bg-slate-600 disabled:opacity-40"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
