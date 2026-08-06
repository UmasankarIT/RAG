'use client'

// Teaching bot chat UI — talks to the 3H Pedagogical Agent.
// Mode 3 (TEACH): POST /api/teach { learnerExtKey, topic, drafts } -> { answer, citations, nodesUsed, usedVisual, grounded, smallTalk }
// Mode 4 (ASSESS), routed here whenever the input contains "quiz":
//   POST /api/assess/ask { topic, drafts, count } -> [{ itemKey, objKey, vector, taxonomyLevel, stem, options }, ...]
//   POST /api/assess/grade { itemKey, learnerExtKey, response } -> { score, anchorLabel, evidence, errorType, facultyFlag, ... }
// Mode 6 (SIMULATE), routed here whenever the input mentions "simulate" / "case" / "role-play":
//   POST /api/simulate/start { learnerExtKey, topic, drafts } -> { simulationId, turnNumber, text }
//   POST /api/simulate/turn  { simulationId, learnerExtKey, action } -> { text, ended, debrief? }
//   POST /api/simulate/end   { simulationId, learnerExtKey } -> { grades, feedback }
// All routes return { ok: true, data } or { ok: false, error }.
// See src/server.ts for the routes and src/modes/{teach,assess,simulate}.ts for what backs them.

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  BotMessageSquare,
  Brain,
  CheckCircle2,
  Hand,
  Heart,
  HelpCircle,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Stethoscope,
  Trash2,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Talk to the backend directly rather than through the Next.js dev-server's
// rewrite proxy (frontend/next.config.ts) — that proxy gives up on an idle
// connection within a couple seconds, which a Claude retry-on-overload cycle
// routinely exceeds, surfacing as ECONNRESET/"socket hang up" even though the
// backend was still working. A direct call has no such artificial timeout.
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3000'

const TEACH_API_URL = `${BACKEND_URL}/api/teach`
const ASSESS_ASK_URL = `${BACKEND_URL}/api/assess/ask`
const ASSESS_GRADE_URL = `${BACKEND_URL}/api/assess/grade`
const ASSESS_GRADE_BATCH_URL = `${BACKEND_URL}/api/assess/grade-batch`
const ASSESS_FEEDBACK_URL = `${BACKEND_URL}/api/assess/feedback`
const CHAT_HISTORY_URL = `${BACKEND_URL}/api/chat/history`
const CURRICULUM_URL = `${BACKEND_URL}/api/curriculum`
const SIMULATE_START_URL = `${BACKEND_URL}/api/simulate/start`
const SIMULATE_TURN_URL = `${BACKEND_URL}/api/simulate/turn`
const SIMULATE_END_URL = `${BACKEND_URL}/api/simulate/end`

const CHAT_KEY = 'ai-tutor-chat-v2'
const LEARNER_KEY = 'ai-tutor-learner-id'
const DRAFTS_KEY = 'ai-tutor-include-drafts'

/** "quiz me on X" / "quiz: angle closure" — anything with "quiz" routes to Mode 4 instead of Mode 3. */
const QUIZ_RE = /\bquiz\b/i

/** A "quiz me" request is a full exam: 12 questions, mixed taxonomy levels, answer-all-then-reveal. */
const QUIZ_COUNT = 12

/** "plan my learning" / "what should I study" — routes to Mode 2 instead of Mode 3. Checked before QUIZ_RE. */
const CURRICULUM_RE = /\bplan my learning\b|\bwhat should i (?:study|learn)\b|\bstudy plan\b|\blearning plan\b/i

/** "simulate a patient" / "give me a case" / "role-play" — routes to Mode 6 instead of Mode 3. Checked before QUIZ_RE. */
const SIMULATE_RE = /\bsimulate\b|\brole.?play\b|\bgive me a case\b|\bstandardized patient\b|\bpractice (?:a |on a )?(?:case|patient)\b/i

interface NodeRef {
  knKey: string
  vector: string
  title: string | null
  sourceTitle: string | null
}

interface ImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/** Structured teaching turn: summary -> image -> caption -> 3H -> question -> follow-ups. Only present when grounded. */
interface TeachSections {
  summary: string
  imageRegion?: ImageRegion
  imageCaption?: string
  head: string
  heart: string
  hands: string
  question: string
  suggestedQuestions?: string[]
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
  /** The objective's own statement — used to label post-exam focus-area recommendations. */
  objStatement: string
  vector: string
  taxonomyLevel: string | null
  stem: string
  options: string[]
  /** One rationale per option, same order — revealed alongside the answer once graded. */
  rationale: string[]
}

interface QuizGrade {
  itemKey: string
  objKey: string
  /** The objective's own statement — forwarded to Mode 5 (Feedback) as its "Feed-Up" restatement. */
  objStatement: string
  /** FK to the objective — forwarded to Mode 5, which writes the review queue directly from it. */
  objectiveId: string
  /** The question actually asked — context for Mode 5's gap analysis. */
  stem: string
  vector: string
  /** Correct option letter (e.g. "A") — present once this response is graded. */
  correctAnswerKey: string | null
  score: number
  anchorLabel: string
  evidence: string
  errorType: string
  misconception?: string
  graderConfidence: string
  facultyFlag: boolean
  mastery: { head: number; heart: number; hands: number }
}

/** Mode 5 (Feedback): the fixed five-part mentor response generated right after an exam is graded. */
interface FeedbackResult {
  reaction: string
  feedUp: string
  feedBack: string
  feedForward: string
  affectiveClose: string
  focusObjKeys: string[]
  scheduledReview: string[]
}

interface SequencedObjective {
  objKey: string
  statement: string
  vector: string
  taxonomyLevel: string | null
  rationale: string
}

interface DueReviewItem {
  objKey: string
  statement: string
  dueAt: string
}

interface CoverageGap {
  sourceKey: string
  sourceTitle: string | null
  missingVectors: string[]
}

/** Mode 2 (Curriculum): stateless study-plan snapshot — entry point + sequence are the LLM's judgment call, the rest is deterministic. */
interface CurriculumResult {
  entryPoint: SequencedObjective | null
  sequence: SequencedObjective[]
  dueForReview: DueReviewItem[]
  coverageGaps: CoverageGap[]
}

/** One line of a Mode 6 (Simulate) conversation — the hidden case state never reaches the client. */
interface SimTurn {
  role: 'learner' | 'agent'
  text: string
}

interface SimStartResult {
  simulationId: string
  turnNumber: number
  text: string
}

/**
 * Mode 4 debrief + Mode 5 feedback, auto-attached to the turn response that
 * resolves the case (or returned directly by /api/simulate/end). Grades share
 * QuizGrade's shape — the backend's GradeResult type is the same for both.
 */
interface SimDebrief {
  grades: QuizGrade[]
  feedback: FeedbackResult | null
}

interface SimTurnResult {
  simulationId: string
  turnNumber: number
  text: string
  ended: boolean
  debrief?: SimDebrief
}

interface BotMsg {
  id: string
  role: 'user' | 'bot'
  kind?: 'quiz' | 'exam' | 'curriculum' | 'simulate'
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
  // quiz-only fields (single instant-graded question)
  quiz?: QuizItem
  selectedOption?: number
  grade?: QuizGrade
  grading?: boolean
  // exam-only fields (12-question batch: answer all, then reveal + recommendations)
  examItems?: QuizItem[]
  examAnswers?: Record<string, number>
  examGrades?: Record<string, QuizGrade>
  examSubmitting?: boolean
  // Mode 5 (Feedback) — generated automatically right after examGrades lands.
  feedback?: FeedbackResult | null
  feedbackLoading?: boolean
  // Mode 2 (Curriculum) — present only for kind: 'curriculum' messages.
  curriculum?: CurriculumResult
  // Mode 6 (Simulate) — present only for kind: 'simulate' messages.
  simulationId?: string
  simTurns?: SimTurn[]
  simEnded?: boolean
  simSending?: boolean
  simDebrief?: SimDebrief
  /** Scoped to the simulate card so a mid-conversation failure doesn't blank out the transcript so far (unlike top-level `error`). */
  simError?: string
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

function fetchQuizGradeBatch(
  learnerExtKey: string,
  responses: { itemKey: string; response: string }[],
) {
  return postJson<QuizGrade[]>(ASSESS_GRADE_BATCH_URL, { learnerExtKey, responses })
}

/** Mode 5 (Feedback) — called automatically right after grades come back, forwarding them verbatim. */
function fetchFeedback(learnerExtKey: string, grades: QuizGrade[]) {
  return postJson<FeedbackResult | null>(ASSESS_FEEDBACK_URL, { learnerExtKey, grades })
}

function fetchCurriculum(learnerExtKey: string) {
  return postJson<CurriculumResult>(CURRICULUM_URL, { learnerExtKey })
}

function fetchSimulateStart(learnerExtKey: string, topic: string, drafts: boolean) {
  return postJson<SimStartResult>(SIMULATE_START_URL, { learnerExtKey, topic, drafts })
}

function fetchSimulateTurn(simulationId: string, learnerExtKey: string, action: string) {
  return postJson<SimTurnResult>(SIMULATE_TURN_URL, { simulationId, learnerExtKey, action })
}

function fetchSimulateEnd(simulationId: string, learnerExtKey: string) {
  return postJson<SimDebrief>(SIMULATE_END_URL, { simulationId, learnerExtKey })
}

async function getJson<T>(url: string): Promise<FetchResult<T>> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
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

interface ChatHistoryRow {
  role: 'user' | 'bot'
  text: string
  createdAt: string
}

/** The server-side Teach conversation (§4 session_history) — survives this browser's localStorage being cleared. */
function fetchChatHistory(learnerExtKey: string) {
  return getJson<ChatHistoryRow[]>(
    `${CHAT_HISTORY_URL}?learnerExtKey=${encodeURIComponent(learnerExtKey)}`,
  )
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
    // Respect an explicit prior choice; otherwise stay defaulted to on.
    try {
      const storedDrafts = localStorage.getItem(DRAFTS_KEY)
      if (storedDrafts !== null) setIncludeDrafts(storedDrafts === '1')
    } catch {
      /* fine */
    }

    let cancelled = false
    const loadLocal = () => {
      try {
        const raw = localStorage.getItem(CHAT_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as BotMsg[]
          if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed)
        }
      } catch {
        /* fine */
      }
    }

    // Server history is the durable copy (survives this browser's storage
    // being cleared) — prefer it when it has anything. It only carries plain
    // Teach-turn text (no citations/images/exam state, see modes/teach.ts),
    // so a restored conversation shows as plain bubbles rather than the rich
    // cards a live answer gets — a known trade-off, not a bug.
    fetchChatHistory(learnerId()).then((result) => {
      if (cancelled) return
      if (result.ok && result.data.length > 0) {
        setMessages(
          result.data.map((m) => ({ id: uid(), role: m.role, text: m.text })),
        )
        return
      }
      loadLocal()
    })

    return () => {
      cancelled = true
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
  }, [messages])

  // Scroll to the newest message only when one is actually added/removed —
  // NOT on every in-place edit to an existing message (e.g. selecting an
  // exam answer just updates one field on the same message via .map(), which
  // was re-triggering this on the whole `messages` array and yanking the
  // view down past the rest of a 12-question exam on every single click).
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  const clearHistory = () => {
    setMessages([GREETING])
    try {
      localStorage.removeItem(CHAT_KEY)
    } catch {
      /* fine */
    }
    setShowSettings(false)
  }

  const sendMessage = async (topicOverride?: string) => {
    const topic = (topicOverride ?? input).trim()
    if (!topic || sending) return
    if (!topicOverride) setInput('')
    setSending(true)

    const userMsg: BotMsg = { id: uid(), role: 'user', text: topic }
    const botId = uid()
    setMessages((prev) => [...prev, userMsg, { id: botId, role: 'bot', text: '', pending: true }])

    if (CURRICULUM_RE.test(topic)) {
      const result = await fetchCurriculum(learnerId())
      setMessages((prev) => {
        const withoutPlaceholder = prev.filter((m) => m.id !== botId)
        if (!result.ok) {
          return [...withoutPlaceholder, { id: botId, role: 'bot', text: '', error: result.error }]
        }
        const curriculumMsg: BotMsg = {
          id: botId,
          role: 'bot',
          kind: 'curriculum',
          text: '',
          curriculum: result.data,
        }
        return [...withoutPlaceholder, curriculumMsg]
      })
      setSending(false)
      return
    }

    if (SIMULATE_RE.test(topic)) {
      const result = await fetchSimulateStart(learnerId(), topic, includeDrafts)
      setMessages((prev) => {
        const withoutPlaceholder = prev.filter((m) => m.id !== botId)
        if (!result.ok) {
          return [...withoutPlaceholder, { id: botId, role: 'bot', text: '', error: result.error }]
        }
        const simMsg: BotMsg = {
          id: botId,
          role: 'bot',
          kind: 'simulate',
          text: '',
          simulationId: result.data.simulationId,
          simTurns: [{ role: 'agent', text: result.data.text }],
          simEnded: false,
        }
        return [...withoutPlaceholder, simMsg]
      })
      setSending(false)
      return
    }

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
        const examMsg: BotMsg = {
          id: botId,
          role: 'bot',
          kind: 'exam',
          text: '',
          examItems: result.data,
          examAnswers: {},
        }
        return [...withoutPlaceholder, examMsg]
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

  /** Select an answer within a 12-question exam — no grading feedback until the whole exam is submitted. */
  const answerExamQuestion = (msgId: string, itemKey: string, optionIndex: number) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && !m.examGrades
          ? { ...m, examAnswers: { ...m.examAnswers, [itemKey]: optionIndex } }
          : m,
      ),
    )
  }

  /** Grade every answered question in the exam at once, then reveal results + focus-area recommendations. */
  const submitExam = async (msgId: string) => {
    const msg = messages.find((m) => m.id === msgId)
    if (!msg?.examItems || msg.examGrades || msg.examSubmitting) return
    const answers = msg.examAnswers ?? {}

    const responses = msg.examItems
      .filter((item) => answers[item.itemKey] !== undefined)
      .map((item) => {
        const optionIndex = answers[item.itemKey]!
        const optionText = item.options[optionIndex] ?? ''
        return { itemKey: item.itemKey, response: `${String.fromCharCode(65 + optionIndex)}. ${optionText}` }
      })
    if (responses.length === 0) return

    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, examSubmitting: true } : m)))

    const result = await fetchQuizGradeBatch(learnerId(), responses)

    if (!result.ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, examSubmitting: false, error: result.error } : m)),
      )
      return
    }

    const examGrades: Record<string, QuizGrade> = {}
    for (const g of result.data) {
      if (g.itemKey) examGrades[g.itemKey] = g
    }
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, examSubmitting: false, examGrades, feedbackLoading: true } : m)),
    )

    // Mode 5 (Feedback) — auto-offered right after grading, per spec. A
    // failure here shouldn't disrupt the grade reveal, which already landed.
    const feedbackResult = await fetchFeedback(learnerId(), result.data)
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? { ...m, feedbackLoading: false, feedback: feedbackResult.ok ? feedbackResult.data : null }
          : m,
      ),
    )
  }

  /** Send the learner's next in-character action; auto-attaches the debrief if the model resolves the case on this turn. */
  const sendSimTurn = async (msgId: string, action: string) => {
    const msg = messages.find((m) => m.id === msgId)
    if (!msg?.simulationId || msg.simEnded || msg.simSending || !action.trim()) return

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              simTurns: [...(m.simTurns ?? []), { role: 'learner', text: action }],
              simSending: true,
              simError: undefined,
            }
          : m,
      ),
    )

    const result = await fetchSimulateTurn(msg.simulationId, learnerId(), action)

    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m
        if (!result.ok) return { ...m, simSending: false, simError: result.error }
        return {
          ...m,
          simSending: false,
          simTurns: [...(m.simTurns ?? []), { role: 'agent', text: result.data.text }],
          simEnded: result.data.ended,
          ...(result.data.debrief ? { simDebrief: result.data.debrief } : {}),
        }
      }),
    )
  }

  /** Learner-initiated early stop — same debrief path as a natural case resolution. */
  const endSimNow = async (msgId: string) => {
    const msg = messages.find((m) => m.id === msgId)
    if (!msg?.simulationId || msg.simEnded || msg.simSending) return

    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, simSending: true, simError: undefined } : m)))

    const result = await fetchSimulateEnd(msg.simulationId, learnerId())

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? result.ok
            ? { ...m, simSending: false, simEnded: true, simDebrief: result.data }
            : { ...m, simSending: false, simError: result.error }
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
                  ) : msg.kind === 'exam' && msg.examItems ? (
                    <ExamCard
                      msg={msg}
                      onAnswer={(itemKey, i) => answerExamQuestion(msg.id, itemKey, i)}
                      onSubmit={() => submitExam(msg.id)}
                    />
                  ) : msg.kind === 'curriculum' && msg.curriculum ? (
                    <CurriculumCard plan={msg.curriculum} />
                  ) : msg.kind === 'simulate' && msg.simTurns ? (
                    <SimulateCard
                      msg={msg}
                      onSend={(action) => sendSimTurn(msg.id, action)}
                      onEnd={() => endSimNow(msg.id)}
                    />
                  ) : msg.sections ? (
                    <TeachTurn msg={msg} onAskFollowUp={(topic) => sendMessage(topic)} />
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 text-[13px] leading-relaxed text-justify [text-justify:inter-word]">
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
            placeholder="Ask about a topic...."
            className="flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => sendMessage()}
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

/**
 * Path segments must survive as separate segments — only encode within each.
 * When the model localized the relevant content to part of the page, pass its
 * bounding box (fractions 0-1) so the backend crops server-side instead of
 * showing the whole page image.
 */
function pageImageUrl(imageKey: string, region?: ImageRegion): string {
  const base = `${BACKEND_URL}/api/pages/${imageKey.split('/').map(encodeURIComponent).join('/')}`
  if (!region) return base
  const params = new URLSearchParams({
    x: String(region.x),
    y: String(region.y),
    w: String(region.width),
    h: String(region.height),
  })
  return `${base}?${params.toString()}`
}

const THREE_H_BORDER: Record<'slate' | 'rose' | 'teal', string> = {
  slate: 'border-slate-300 dark:border-slate-500/40',
  rose: 'border-rose-300 dark:border-rose-500/40',
  teal: 'border-teal-300 dark:border-teal-500/40',
}

const THREE_H_ICON: Record<'slate' | 'rose' | 'teal', string> = {
  slate: 'text-slate-500 dark:text-slate-400',
  rose: 'text-rose-500 dark:text-rose-400',
  teal: 'text-teal-600 dark:text-teal-400',
}

function ThreeHBlock({
  label,
  color,
  icon: Icon,
  text,
}: {
  label: string
  color: keyof typeof THREE_H_BORDER
  icon: typeof Brain
  text: string
}) {
  return (
    <div className={cn('space-y-1 border-l-2 pl-3', THREE_H_BORDER[color])}>
      <div className="flex items-center gap-1.5 text-[10px] leading-none font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className={cn('size-3 shrink-0', THREE_H_ICON[color])} />
        <span className="leading-none">{label}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-justify [text-justify:inter-word]">{text}</p>
    </div>
  )
}

/**
 * Mode 3 (TEACH) grounded answer, laid out as: summary -> corresponding page
 * image (cropped to the relevant region when the model localized one) ->
 * caption -> HEAD/HEART/HANDS -> closing retrieval question ->
 * suggested follow-up questions -> citations.
 */
function TeachTurn({ msg, onAskFollowUp }: { msg: BotMsg; onAskFollowUp: (topic: string) => void }) {
  const sections = msg.sections
  if (!sections) return null

  return (
    <div className="max-w-full space-y-3 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <p className="text-[13px] leading-relaxed text-justify [text-justify:inter-word]">{sections.summary}</p>

      {msg.imageKey && (
        <figure className="space-y-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- served from our own backend, not next/image's remote loader */}
          <img
            src={pageImageUrl(msg.imageKey, sections.imageRegion)}
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
        <ThreeHBlock label="HEAD" color="slate" icon={Brain} text={sections.head} />
        <ThreeHBlock label="HEART" color="rose" icon={Heart} text={sections.heart} />
        <ThreeHBlock label="HANDS" color="teal" icon={Hand} text={sections.hands} />
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-[12.5px] text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        {sections.question}
      </div>

      {sections.suggestedQuestions && sections.suggestedQuestions.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Go deeper
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sections.suggestedQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAskFollowUp(q)}
                className="rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-left text-[11.5px] text-foreground/80 transition-colors hover:border-teal-400 hover:bg-teal-50 hover:text-teal-800 dark:hover:bg-teal-500/10 dark:hover:text-teal-300"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

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

/**
 * Mode 4 (ASSESS) exam: 12 questions across mixed taxonomy levels, in random
 * order. Select an answer for each — no feedback shown until every question
 * is answered and submitted together. On submit: reveal correct answers,
 * per-question scoring, and focus-area recommendations built from the
 * lowest-scoring objectives.
 */
function ExamCard({
  msg,
  onAnswer,
  onSubmit,
}: {
  msg: BotMsg
  onAnswer: (itemKey: string, optionIndex: number) => void
  onSubmit: () => void
}) {
  const items = msg.examItems
  if (!items || items.length === 0) return null
  const answers = msg.examAnswers ?? {}
  const grades = msg.examGrades
  const submitted = !!grades
  const answeredCount = items.filter((item) => answers[item.itemKey] !== undefined).length
  const allAnswered = answeredCount === items.length

  const overallAvg = submitted
    ? Object.values(grades).reduce((sum, g) => sum + g.score, 0) / Math.max(1, Object.values(grades).length)
    : 0

  return (
    <div className="max-w-full space-y-4 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
          <HelpCircle className="size-3" />
          Exam · {items.length} questions
        </div>
        {submitted ? (
          <div className="text-[11px] font-semibold text-muted-foreground">
            {overallAvg.toFixed(1)}/4 average
          </div>
        ) : (
          <div className="text-[10.5px] text-muted-foreground">
            {answeredCount}/{items.length} answered
          </div>
        )}
      </div>

      <div className="space-y-4">
        {items.map((item, qi) => {
          const selected = answers[item.itemKey]
          const grade = grades?.[item.itemKey]
          const correctIndex = grade?.correctAnswerKey
            ? grade.correctAnswerKey.charCodeAt(0) - 65
            : undefined

          return (
            <div
              key={item.itemKey}
              className="space-y-1.5 border-t border-border/60 pt-3 first:border-t-0 first:pt-0"
            >
              <div className="text-[11px] font-medium text-muted-foreground">
                {qi + 1}. {item.objKey}
                {item.taxonomyLevel && ` · ${item.taxonomyLevel}`}
              </div>
              <div className="text-[13px] leading-relaxed">{item.stem}</div>
              <div className="space-y-1.5">
                {item.options.map((option, i) => {
                  const letter = String.fromCharCode(65 + i)
                  const isSelected = selected === i
                  const isCorrectOption = submitted && correctIndex === i
                  const isWrongSelection = submitted && isSelected && !isCorrectOption
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={submitted}
                      onClick={() => onAnswer(item.itemKey, i)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-[12.5px] transition-colors',
                        !submitted &&
                          !isSelected &&
                          'border-border/60 hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-500/10',
                        !submitted && isSelected && 'border-teal-400 bg-teal-50 dark:bg-teal-500/10',
                        submitted && isCorrectOption && 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10',
                        submitted && isWrongSelection && 'border-rose-300 bg-rose-50 dark:bg-rose-500/10',
                        submitted && !isCorrectOption && !isWrongSelection && 'border-border/40 opacity-60',
                      )}
                    >
                      <span className="font-mono font-semibold opacity-70">{letter}.</span>
                      <span className="flex-1">{option}</span>
                      {submitted && isCorrectOption && (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                      )}
                      {submitted && isWrongSelection && (
                        <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-600" />
                      )}
                    </button>
                  )
                })}
              </div>
              {grade && (
                <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-[11.5px]">
                  <span className="font-semibold">{grade.score}/4 — {grade.anchorLabel}. </span>
                  <span className="text-muted-foreground">{grade.evidence}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!submitted && (
        <button
          type="button"
          disabled={!allAnswered || msg.examSubmitting}
          onClick={onSubmit}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-700 px-3 py-2 text-[12.5px] font-medium text-white transition-colors hover:bg-slate-600 disabled:opacity-40"
        >
          {msg.examSubmitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : allAnswered ? (
            'Submit all answers'
          ) : (
            `Answer all ${items.length} questions to submit`
          )}
        </button>
      )}

      {msg.error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {msg.error}
        </div>
      )}

      {msg.feedbackLoading && (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          Preparing feedback...
        </div>
      )}

      {msg.feedback && (
        <div className="space-y-2.5 rounded-2xl border border-rose-200 bg-rose-50/60 px-4 py-3.5 dark:border-rose-500/30 dark:bg-rose-500/5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
            <Heart className="size-3" />
            Mentor feedback
          </div>
          <p className="text-[12.5px] leading-relaxed">{msg.feedback.reaction}</p>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">{msg.feedback.feedUp}</p>
          <p className="text-[12.5px] leading-relaxed">{msg.feedback.feedBack}</p>
          <div className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-[12px] text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
            <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
            {msg.feedback.feedForward}
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground italic">
            {msg.feedback.affectiveClose}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Mode 6 (SIMULATE): a turn-based case, embedded as its own mini-chat inside
 * the message card. The learner types actions/questions in-character; the
 * card resolves either when the model naturally concludes the case (the
 * `turn` response carries a debrief inline) or the learner ends it early.
 */
function SimulateCard({
  msg,
  onSend,
  onEnd,
}: {
  msg: BotMsg
  onSend: (action: string) => void
  onEnd: () => void
}) {
  const [draft, setDraft] = useState('')
  const turns = msg.simTurns ?? []
  const ended = !!msg.simEnded
  const debrief = msg.simDebrief

  const submit = () => {
    const action = draft.trim()
    if (!action || msg.simSending || ended) return
    setDraft('')
    onSend(action)
  }

  return (
    <div className="max-w-full space-y-3 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
          <Stethoscope className="size-3" />
          Simulation
        </div>
        {ended && (
          <div className="text-[10.5px] font-medium text-muted-foreground">case closed</div>
        )}
      </div>

      <div className="space-y-2">
        {turns.map((t, i) => (
          <div key={i} className={cn('flex', t.role === 'learner' && 'justify-end')}>
            <div
              className={cn(
                'max-w-[85%] rounded-xl px-3 py-2 text-[12.5px] leading-relaxed',
                t.role === 'learner'
                  ? 'bg-slate-700 text-white'
                  : 'border border-border/60 bg-background/60 italic',
              )}
            >
              {t.text}
            </div>
          </div>
        ))}
      </div>

      {msg.simError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {msg.simError}
        </div>
      )}

      {!ended && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/80 pl-3 pr-1.5 py-1 focus-within:border-teal-400">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              disabled={msg.simSending}
              placeholder="What do you say or do next?"
              className="flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || msg.simSending}
              className="grid size-8 place-items-center rounded-lg bg-slate-700 text-white transition-colors hover:bg-slate-600 disabled:opacity-40"
            >
              {msg.simSending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            </button>
          </div>
          <button
            type="button"
            onClick={onEnd}
            disabled={msg.simSending}
            className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
          >
            End case now and get feedback
          </button>
        </div>
      )}

      {debrief && (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Debrief
          </div>
          {debrief.grades.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No specific objective was reached this run — try engaging more with the case next time.
            </p>
          ) : (
            <div className="space-y-2">
              {debrief.grades.map((g) => (
                <div
                  key={g.itemKey}
                  className="rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-[11.5px]"
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    {(() => {
                      const Icon = vectorIcon(g.vector)
                      return <Icon className={cn('size-3 shrink-0', THREE_H_ICON[vectorColor(g.vector)])} />
                    })()}
                    {g.objStatement} — {g.score}/4 ({g.anchorLabel})
                  </div>
                  <div className="mt-0.5 text-muted-foreground">{g.evidence}</div>
                </div>
              ))}
            </div>
          )}

          {debrief.feedback && (
            <div className="space-y-2.5 rounded-2xl border border-rose-200 bg-rose-50/60 px-4 py-3.5 dark:border-rose-500/30 dark:bg-rose-500/5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                <Heart className="size-3" />
                Mentor feedback
              </div>
              <p className="text-[12.5px] leading-relaxed">{debrief.feedback.reaction}</p>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{debrief.feedback.feedUp}</p>
              <p className="text-[12.5px] leading-relaxed">{debrief.feedback.feedBack}</p>
              <div className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-[12px] text-teal-800 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
                <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
                {debrief.feedback.feedForward}
              </div>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground italic">
                {debrief.feedback.affectiveClose}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function vectorIcon(vector: string) {
  if (vector === 'HEART') return Heart
  if (vector === 'HANDS') return Hand
  return Brain
}

function vectorColor(vector: string): keyof typeof THREE_H_ICON {
  if (vector === 'HEART') return 'rose'
  if (vector === 'HANDS') return 'teal'
  return 'slate'
}

/**
 * Mode 2 (Curriculum): stateless study-plan snapshot — due-for-review and
 * content gaps are deterministic (computed from data Modes 3/4/5 already
 * write); the entry point and sequence are the model's one judgment call,
 * since no prerequisite graph exists anywhere in this schema.
 */
function CurriculumCard({ plan }: { plan: CurriculumResult }) {
  return (
    <div className="max-w-full space-y-4 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
        <BookOpen className="size-3" />
        Study plan
      </div>

      {plan.dueForReview.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            Due for review
          </div>
          <ul className="space-y-1">
            {plan.dueForReview.map((d) => (
              <li
                key={d.objKey}
                className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              >
                {d.statement}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.entryPoint ? (
        <>
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Start here
            </div>
            <div className="rounded-xl border border-teal-300 bg-teal-50 px-3 py-2.5 dark:border-teal-500/40 dark:bg-teal-500/10">
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-teal-800 dark:text-teal-300">
                {(() => {
                  const Icon = vectorIcon(plan.entryPoint.vector)
                  return <Icon className="size-3.5 shrink-0" />
                })()}
                {plan.entryPoint.statement}
              </div>
              <p className="mt-1 text-[11.5px] text-teal-700/80 dark:text-teal-400/80">
                {plan.entryPoint.rationale}
              </p>
            </div>
          </div>

          {plan.sequence.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Then</div>
              <ol className="space-y-1.5">
                {plan.sequence.map((s, i) => {
                  const Icon = vectorIcon(s.vector)
                  return (
                    <li
                      key={s.objKey}
                      className="flex items-start gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-[12px]"
                    >
                      <span className="font-mono font-semibold text-muted-foreground opacity-70">{i + 1}.</span>
                      <Icon className={cn('mt-0.5 size-3.5 shrink-0', THREE_H_ICON[vectorColor(s.vector)])} />
                      <span className="flex-1">
                        <span className="font-medium">{s.statement}</span>
                        <span className="block text-muted-foreground">{s.rationale}</span>
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
        </>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Everything currently available has been mastered — nothing new to recommend right now.
        </p>
      )}

      {plan.coverageGaps.length > 0 && (
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Content gaps
          </div>
          <ul className="space-y-1">
            {plan.coverageGaps.map((g) => (
              <li
                key={g.sourceKey}
                className="flex items-start gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-[11.5px] text-muted-foreground"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span>
                  <span className="font-medium text-foreground">{g.sourceTitle ?? g.sourceKey}</span> is missing{' '}
                  {g.missingVectors.join(', ')} content.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
