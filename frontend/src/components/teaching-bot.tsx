'use client'

// Teaching bot chat UI — talks to the 3H Pedagogical Agent.
// Mode 3 (TEACH): POST /api/teach { learnerExtKey, topic, drafts } -> { answer, citations, nodesUsed, usedVisual, grounded, smallTalk }
// Mode 4 (ASSESS), routed here whenever the input contains "quiz":
//   POST /api/assess/ask { topic, drafts, count } -> [{ itemKey, objKey, vector, taxonomyLevel, stem, options }, ...]
//   POST /api/assess/grade { itemKey, learnerExtKey, response } -> { score, anchorLabel, evidence, errorType, facultyFlag, ... }
// All routes return { ok: true, data } or { ok: false, error }.
// See src/server.ts for the routes and src/modes/{teach,assess}.ts for what backs them.

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  BotMessageSquare,
  CheckCircle2,
  HelpCircle,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const TEACH_API_URL = '/api/teach'
const ASSESS_ASK_URL = '/api/assess/ask'
const ASSESS_GRADE_URL = '/api/assess/grade'

const CHAT_KEY = 'ai-tutor-chat-v2'
const LEARNER_KEY = 'ai-tutor-learner-id'
const DRAFTS_KEY = 'ai-tutor-include-drafts'

/** "quiz me on X" / "quiz: angle closure" — anything with "quiz" routes to Mode 4 instead of Mode 3. */
const QUIZ_RE = /\bquiz\b/i

/** A "quiz me" request generates this many distinct questions, not just one. */
const QUIZ_COUNT = 5

interface NodeRef {
  knKey: string
  vector: string
  title: string | null
  sourceTitle: string | null
}

/** Structured teaching turn: summary -> image -> caption -> 3H -> question. Only present when grounded. */
interface TeachSections {
  summary: string
  imageCaption?: string
  head: string
  heart: string
  hands: string
  question: string
}

interface BotReply {
  answer: string
  citations: string[]
  nodesUsed: NodeRef[]
  usedVisual: boolean
  grounded: boolean
  smallTalk: boolean
  sections: TeachSections | null
  imageKey: string | null
}

interface QuizItem {
  itemKey: string
  objKey: string
  vector: string
  taxonomyLevel: string | null
  stem: string
  options: string[]
}

interface QuizGrade {
  score: number
  anchorLabel: string
  evidence: string
  errorType: string
  misconception?: string
  facultyFlag: boolean
}

interface BotMsg {
  id: string
  role: 'user' | 'bot'
  kind?: 'quiz'
  text: string
  citations?: string[]
  nodesUsed?: NodeRef[]
  usedVisual?: boolean
  grounded?: boolean
  smallTalk?: boolean
  sections?: TeachSections | null
  imageKey?: string | null
  pending?: boolean
  error?: string
  // quiz-only fields
  quiz?: QuizItem
  selectedOption?: number
  grade?: QuizGrade
  grading?: boolean
}

type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function postJson<T>(url: string, body: unknown): Promise<FetchResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const parsed = (await res.json().catch(() => null)) as
      | { ok: boolean; data?: T; error?: unknown }
      | null
    if (!res.ok || !parsed || !parsed.ok || parsed.data === undefined) {
      const detail =
        typeof parsed?.error === 'string' ? parsed.error : `request failed (${res.status})`
      return { ok: false, error: detail }
    }
    return { ok: true, data: parsed.data }
  } catch {
    return { ok: false, error: 'could not reach the backend — is the server running?' }
  }
}

function fetchAiReply(learnerExtKey: string, topic: string, drafts: boolean) {
  return postJson<BotReply>(TEACH_API_URL, { learnerExtKey, topic, drafts })
}

function fetchQuizItems(topic: string, drafts: boolean, count: number) {
  return postJson<QuizItem[]>(ASSESS_ASK_URL, { topic, drafts, count })
}

function fetchQuizGrade(itemKey: string, learnerExtKey: string, response: string) {
  return postJson<QuizGrade>(ASSESS_GRADE_URL, { itemKey, learnerExtKey, response })
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
  // Defaults to on: no faculty-review workflow exists yet, so gating on
  // status==='reviewed' would just mean every question comes back empty.
  const [includeDrafts, setIncludeDrafts] = useState(true)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as BotMsg[]
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed)
      }
      // Respect an explicit prior choice; otherwise stay defaulted to on.
      const storedDrafts = localStorage.getItem(DRAFTS_KEY)
      if (storedDrafts !== null) setIncludeDrafts(storedDrafts === '1')
    } catch {
      /* fine */
    }
  }, [])

  const toggleDrafts = () => {
    setIncludeDrafts((prev) => {
      const next = !prev
      try {
        localStorage.setItem(DRAFTS_KEY, next ? '1' : '0')
      } catch {
        /* fine */
      }
      return next
    })
  }

  useEffect(() => {
    const settled = messages.filter((m) => !m.pending)
    if (settled.length > 1) {
      try {
        localStorage.setItem(CHAT_KEY, JSON.stringify(settled))
      } catch {
        /* fine */
      }
    }
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
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

    if (QUIZ_RE.test(topic)) {
      const result = await fetchQuizItems(topic, includeDrafts, QUIZ_COUNT)
      setMessages((prev) => {
        const withoutPlaceholder = prev.filter((m) => m.id !== botId)
        if (!result.ok) {
          return [...withoutPlaceholder, { id: botId, role: 'bot', text: '', error: result.error }]
        }
        if (result.data.length === 0) {
          return [
            ...withoutPlaceholder,
            { id: botId, role: 'bot', text: '', error: `no quiz questions could be generated for "${topic}"` },
          ]
        }
        const quizMsgs: BotMsg[] = result.data.map((item, i) => ({
          id: i === 0 ? botId : uid(),
          role: 'bot',
          kind: 'quiz',
          text: '',
          quiz: item,
        }))
        return [...withoutPlaceholder, ...quizMsgs]
      })
      setSending(false)
      return
    }

    const result = await fetchAiReply(learnerId(), topic, includeDrafts)

    setMessages((prev) =>
      prev.map((m) =>
        m.id === botId
          ? result.ok
            ? {
                id: botId,
                role: 'bot',
                text: result.data.answer,
                citations: result.data.citations,
                nodesUsed: result.data.nodesUsed,
                usedVisual: result.data.usedVisual,
                grounded: result.data.grounded,
                smallTalk: result.data.smallTalk,
                sections: result.data.sections,
                imageKey: result.data.imageKey,
              }
            : { id: botId, role: 'bot', text: '', error: result.error }
          : m,
      ),
    )
    setSending(false)
  }

  const answerQuiz = async (msgId: string, optionIndex: number) => {
    const msg = messages.find((m) => m.id === msgId)
    if (!msg?.quiz || msg.selectedOption !== undefined) return

    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, selectedOption: optionIndex, grading: true } : m)),
    )

    const optionText = msg.quiz.options[optionIndex] ?? ''
    const answerLabel = `${String.fromCharCode(65 + optionIndex)}. ${optionText}`
    const result = await fetchQuizGrade(msg.quiz.itemKey, learnerId(), answerLabel)

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? result.ok
            ? { ...m, grading: false, grade: result.data }
            : { ...m, grading: false, error: result.error }
          : m,
      ),
    )
  }

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border/60 bg-card shadow-sm',
        heightClass,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
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
            <div className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-lg">
              <div className="border-b border-border/60 px-4 py-2.5 text-[11.5px] font-semibold text-muted-foreground">
                Bot Settings
              </div>
              <button
                type="button"
                onClick={toggleDrafts}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-[12.5px] transition-colors hover:bg-foreground/5"
              >
                <span className="flex flex-col">
                  <span className="font-medium">Include unreviewed drafts</span>
                  <span className="text-[10.5px] text-muted-foreground">
                    Use knowledge nodes faculty hasn&apos;t reviewed yet
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    includeDrafts ? 'bg-teal-500' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
                      includeDrafts ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
              <button
                type="button"
                onClick={clearHistory}
                className="flex w-full items-center gap-2 border-t border-border/60 px-4 py-3 text-[12.5px] text-rose-600 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
              >
                <Trash2 className="size-4" />
                Clear chat history
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-5 py-4">
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
                  ) : msg.kind === 'quiz' && msg.quiz ? (
                    <QuizCard msg={msg} onAnswer={(i) => answerQuiz(msg.id, i)} />
                  ) : msg.sections ? (
                    <TeachTurn msg={msg} />
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 text-[13px] leading-relaxed">
                        {msg.text}
                      </div>
                      {!msg.smallTalk && msg.grounded === false && (
                        <div className="flex items-center gap-1 px-1 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="size-3" />
                          general knowledge — not from your ingested sources
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
      <div className="border-t border-border/60 px-5 py-4">
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
            placeholder="Ask about a topic, or say “quiz me on…”"
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

/** Path segments must survive as separate segments — only encode within each. */
function pageImageUrl(imageKey: string): string {
  return `/api/pages/${imageKey.split('/').map(encodeURIComponent).join('/')}`
}

const THREE_H_BORDER: Record<'slate' | 'rose' | 'teal', string> = {
  slate: 'border-slate-300 dark:border-slate-500/40',
  rose: 'border-rose-300 dark:border-rose-500/40',
  teal: 'border-teal-300 dark:border-teal-500/40',
}

function ThreeHBlock({
  label,
  color,
  text,
}: {
  label: string
  color: keyof typeof THREE_H_BORDER
  text: string
}) {
  return (
    <div className={cn('space-y-1 border-l-2 pl-3', THREE_H_BORDER[color])}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="text-[13px] leading-relaxed">{text}</p>
    </div>
  )
}

/**
 * Mode 3 (TEACH) grounded answer, laid out as: summary -> corresponding page
 * image -> caption -> HEAD/HEART/HANDS -> closing retrieval question -> citations.
 */
function TeachTurn({ msg }: { msg: BotMsg }) {
  const sections = msg.sections
  if (!sections) return null

  return (
    <div className="max-w-full space-y-3 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <p className="text-[13px] leading-relaxed">{sections.summary}</p>

      {msg.imageKey && (
        <figure className="space-y-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from our own backend, not next/image's remote loader */}
          <img
            src={pageImageUrl(msg.imageKey)}
            alt={sections.imageCaption ?? 'Source page image'}
            className="max-h-80 w-full rounded-xl border border-border/60 bg-background/60 object-contain"
          />
          {sections.imageCaption && (
            <figcaption className="text-[11.5px] italic text-muted-foreground">
              {sections.imageCaption}
            </figcaption>
          )}
        </figure>
      )}

      <div className="space-y-2.5 border-t border-border/60 pt-2.5">
        <ThreeHBlock label="HEAD" color="slate" text={sections.head} />
        <ThreeHBlock label="HEART" color="rose" text={sections.heart} />
        <ThreeHBlock label="HANDS" color="teal" text={sections.hands} />
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-[12.5px] text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        {sections.question}
      </div>

      {(msg.citations?.length || msg.usedVisual !== undefined) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10.5px] text-muted-foreground">
          {msg.citations?.map((c) => {
            const node = msg.nodesUsed?.find((n) => n.knKey === c)
            const label = node?.title ? `${node.title}` : c
            const sub = node?.sourceTitle ?? (node ? node.vector : undefined)
            return (
              <span
                key={c}
                title={`${c}${node?.sourceTitle ? ` — ${node.sourceTitle}` : ''}`}
                className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-teal-700"
              >
                <BookOpen className="size-2.5 shrink-0" />
                <span className="max-w-40 truncate font-medium">{label}</span>
                {sub && <span className="font-mono text-[9px] opacity-70">· {sub}</span>}
              </span>
            )
          })}
          {msg.usedVisual !== undefined && (
            <span className="opacity-70">
              {msg.usedVisual ? 'matched by visual search' : 'matched by text search'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Mode 4 (ASSESS) inline: one MCQ, click an option, get the anchored-rubric grade back. */
function QuizCard({ msg, onAnswer }: { msg: BotMsg; onAnswer: (optionIndex: number) => void }) {
  const quiz = msg.quiz
  if (!quiz) return null
  const answered = msg.selectedOption !== undefined

  return (
    <div className="max-w-full space-y-2.5 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
        <HelpCircle className="size-3" />
        Quiz · {quiz.objKey}
      </div>
      <div className="text-[13px] leading-relaxed">{quiz.stem}</div>
      <div className="space-y-1.5">
        {quiz.options.map((option, i) => {
          const letter = String.fromCharCode(65 + i)
          const isSelected = msg.selectedOption === i
          const showResult = answered && msg.grade
          const isCorrect = showResult && isSelected && msg.grade!.score >= 3
          return (
            <button
              key={i}
              type="button"
              disabled={answered}
              onClick={() => onAnswer(i)}
              className={cn(
                'flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-[12.5px] transition-colors',
                !answered && 'border-border/60 hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-500/10',
                answered && !isSelected && 'border-border/40 opacity-50',
                isSelected && !showResult && 'border-teal-400 bg-teal-50 dark:bg-teal-500/10',
                isSelected && showResult && isCorrect && 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10',
                isSelected && showResult && !isCorrect && 'border-rose-300 bg-rose-50 dark:bg-rose-500/10',
              )}
            >
              <span className="font-mono font-semibold opacity-70">{letter}.</span>
              <span className="flex-1">{option}</span>
              {isSelected && msg.grading && <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />}
              {isSelected && showResult && (isCorrect ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-600" />
              ))}
            </button>
          )
        })}
      </div>
      {msg.error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {msg.error}
        </div>
      )}
      {msg.grade && (
        <div className="space-y-1 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-[12px]">
          <div className="font-semibold">
            {msg.grade.score}/4 — {msg.grade.anchorLabel}
          </div>
          <div className="text-muted-foreground">{msg.grade.evidence}</div>
          {msg.grade.facultyFlag && (
            <div className="text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
              flagged for faculty review — low grading confidence
            </div>
          )}
        </div>
      )}
    </div>
  )
}
