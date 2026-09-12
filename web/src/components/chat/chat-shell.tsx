"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useAppData } from "@/components/app-data-context";
import { Composer } from "@/components/chat/composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import type { ChatStreamEvent, Citation, DisplayMessage, Grounding, KbSelection } from "@/components/chat/types";

interface RawMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
  grounding: Grounding | null;
}

const DEFAULT_KB_SELECTION: KbSelection = { scope: "all", ids: [] };

/**
 * Split accumulated NDJSON text on newlines, parsing every complete line and
 * returning what's left over (an in-progress final line) to be prepended to
 * the next chunk — stream chunks don't align with line boundaries.
 */
function parseNdjsonLines(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ChatStreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ChatStreamEvent);
    } catch {
      // Malformed line — skip rather than crash the whole stream.
    }
  }
  return { events, rest };
}

export function ChatShell({ sessionId }: { sessionId: string | null }) {
  const router = useRouter();
  const { refreshSessions } = useAppData();

  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [kbSelection, setKbSelection] = useState<KbSelection>(DEFAULT_KB_SELECTION);
  const [loadingHistory, setLoadingHistory] = useState(Boolean(sessionId));
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveSessionId(sessionId);
    if (!sessionId) {
      setMessages([]);
      setKbSelection(DEFAULT_KB_SELECTION);
      setLoadingHistory(false);
      return;
    }

    setLoadingHistory(true);
    fetch(`/api/chat-sessions/${sessionId}`)
      .then((res) => res.json())
      .then(
        (data: {
          ok: boolean;
          data?: {
            session: { knowledgeBaseScope: KbSelection["scope"]; knowledgeBases: { id: string; name: string }[] };
            messages: RawMessage[];
          };
        }) => {
          if (!data.ok || !data.data) return;
          setMessages(
            data.data.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              citations: m.citations,
              grounding: m.grounding,
            })),
          );
          setKbSelection({
            scope: data.data.session.knowledgeBaseScope,
            ids: data.data.session.knowledgeBases.map((kb) => kb.id),
          });
        },
      )
      .finally(() => setLoadingHistory(false));
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(text: string) {
    setStreaming(true);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: text }]);

    let sid = activeSessionId;
    if (!sid) {
      const res = await fetch("/api/chat-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseScope: kbSelection.scope, knowledgeBaseIds: kbSelection.ids }),
      });
      const data: { ok: boolean; data?: { id: string } } = await res.json();
      if (!data.ok || !data.data) {
        setStreaming(false);
        return;
      }
      sid = data.data.id;
      setActiveSessionId(sid);
      router.replace(`/c/${sid}`);
      void refreshSessions();
    }

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid, message: text }),
      });

      if (!res.ok || !res.body) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: `Sorry — ${data.error ?? "something went wrong."}` } : m)),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let lineBuffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });

        const { events, rest } = parseNdjsonLines(lineBuffer);
        lineBuffer = rest;

        for (const event of events) {
          if (event.type === "status") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      status:
                        event.phase === "searching"
                          ? { phase: "searching", kbCount: event.kbCount }
                          : { phase: "searched", count: event.count },
                    }
                  : m,
              ),
            );
          } else if (event.type === "delta") {
            full += event.text;
            const snapshot = full;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: snapshot, status: null } : m)));
          } else if (event.type === "final") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, citations: event.citations, grounding: event.grounding, status: null } : m)),
            );
          } else if (event.type === "error") {
            full += `\n\nSorry — ${event.message}`;
            const snapshot = full;
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: snapshot, status: null } : m)));
          }
        }
      }
    } finally {
      setStreaming(false);
      void refreshSessions();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="thin-scroll flex-1 space-y-5 overflow-y-auto py-6">
        {loadingHistory && <p className="text-center text-sm text-muted-foreground">Loading…</p>}

        {!loadingHistory && messages.length === 0 && <EmptyState />}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} hasKnowledgeBase={kbSelection.scope !== "none"} />
        ))}
        <div ref={bottomRef} />
      </div>

      <Composer
        onSend={handleSend}
        disabled={streaming || loadingHistory}
        kbSelection={kbSelection}
        onKbSelectionChange={setKbSelection}
        knowledgeBaseLocked={Boolean(activeSessionId)}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <Sparkles className="size-8 text-primary" />
      <h2 className="text-xl font-semibold text-foreground">What can I help with?</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Pick a knowledge base below to ground the answer in your own documents, or just start typing for a
        general chat.
      </p>
    </div>
  );
}
