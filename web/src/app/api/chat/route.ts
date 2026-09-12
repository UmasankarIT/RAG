import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { ChatStreamEvent, Citation, Grounding } from "@/components/chat/types";
import { db, schema } from "@/lib/db";
import type { ChatTurn } from "@/lib/llm";
import { classifyGroundingLLM, generateChatTitle, streamChatReply } from "@/lib/llm";
import { requireUserId } from "@/lib/require-user";
import { retrieveChunks } from "@/lib/retrieve";
import type { RetrievedChunk } from "@/lib/retrieve";
import { resolveSessionKnowledgeBases } from "@/lib/session-knowledge-bases";

const chatBody = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(8000),
});

/**
 * §STRUCTURE: substantive answers get a consistent Summary / Key points /
 * Caveats shape (plain markdown headers — no forced tool-call/JSON, so
 * free-flowing token streaming still works unchanged) — trivial replies
 * (greetings, one-word facts) are explicitly exempted so the format doesn't
 * feel forced onto small talk.
 */
const STRUCTURE_RULE = `For a substantive question, structure your answer as:
## Summary
A direct, complete answer in 2-5 sentences.

## Key points
3-6 bullet points expanding on the summary with specifics, examples, or steps.

## Caveats
Important limitations, gaps, or things worth double-checking. Omit this section entirely if there's genuinely nothing to caveat.

For a greeting, small talk, or a question answerable in one short sentence, skip the structure — answer naturally and briefly instead of forcing headers onto a trivial reply.`;

const GENERAL_SYSTEM = `You are a helpful, knowledgeable assistant. Answer clearly and concisely.

${STRUCTURE_RULE}`;

/** Shared with classifyGrounding below — the classifier needs to see the same passages the answer was grounded in, not just the question/answer pair. */
function buildContextText(chunks: RetrievedChunk[], multiKb: boolean): string {
  return chunks
    .map((c, i) => {
      const source = multiKb ? `"${c.documentName}" in knowledge base "${c.knowledgeBaseName}"` : `"${c.documentName}"`;
      return `[${i + 1}] (from ${source})\n${c.content}`;
    })
    .join("\n\n");
}

function buildGroundedSystem(chunks: RetrievedChunk[]): string {
  // Only bother naming which knowledge base a passage came from when more
  // than one is actually in play this turn — noise otherwise.
  const multiKb = new Set(chunks.map((c) => c.knowledgeBaseId)).size > 1;
  const context = buildContextText(chunks, multiKb);
  return `You are a helpful assistant answering questions using the user's uploaded knowledge base${multiKb ? "s" : ""}.

Answer using ONLY the numbered context passages below when they're relevant — cite the passage number(s) inline like [1] or [2, 3]. If the passages don't cover the question, say so plainly and answer from general knowledge instead, making clear you're doing so.

${STRUCTURE_RULE}

Context passages:
${context}`;
}

/**
 * Skips the LLM classification call entirely when nothing was retrieved —
 * that case is unambiguous and free to determine. `context` must be the same
 * passage text the answer was actually generated from — without it, the
 * classifier has no basis to judge grounding at all (an earlier version of
 * this omitted it and the model reasonably concluded "no passages given" ->
 * "general" every single time, regardless of how well-grounded the answer was).
 */
async function classifyGrounding(
  question: string,
  answerText: string,
  context: string,
): Promise<Grounding> {
  if (!context) return "general";
  try {
    return await classifyGroundingLLM(question, answerText, context);
  } catch (error: unknown) {
    console.error("grounding classification failed, defaulting to 'full':", error);
    return "full";
  }
}

export async function POST(request: Request) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = chatBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid input" }, { status: 400 });
  const { sessionId, message } = parsed.data;

  const [session] = await db
    .select()
    .from(schema.chatSessions)
    .where(and(eq(schema.chatSessions.id, sessionId), eq(schema.chatSessions.userId, userId)))
    .limit(1);
  if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const priorMessages = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.chatSessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));
  const isFirstMessage = priorMessages.length === 0;

  await db.insert(schema.chatMessages).values({ chatSessionId: sessionId, role: "user", content: message });

  const history: ChatTurn[] = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content }) as ChatTurn),
    { role: "user", content: message },
  ];

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: ChatStreamEvent) => {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  let fullText = "";

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let citationPayload: Citation[] = [];
      let system = GENERAL_SYSTEM;
      let grounding: Grounding = "general";
      let contextText = "";

      try {
        const scopedKbs = await resolveSessionKnowledgeBases(session);
        if (scopedKbs.length > 0) {
          send(controller, { type: "status", phase: "searching", kbCount: scopedKbs.length });
          const citations = await retrieveChunks(
            scopedKbs.map((kb) => kb.id),
            message,
          );
          send(controller, { type: "status", phase: "searched", count: citations.length });

          if (citations.length > 0) {
            const multiKb = new Set(citations.map((c) => c.knowledgeBaseId)).size > 1;
            contextText = buildContextText(citations, multiKb);
            system = buildGroundedSystem(citations);
            citationPayload = citations.map((c) => ({
              documentId: c.documentId,
              documentName: c.documentName,
              knowledgeBaseName: c.knowledgeBaseName,
              chunkId: c.chunkId,
              snippet: c.content.slice(0, 240),
            }));
          }
        }

        for await (const delta of streamChatReply(system, history)) {
          fullText += delta;
          send(controller, { type: "delta", text: delta });
        }

        grounding = await classifyGrounding(message, fullText, contextText);
        send(controller, { type: "final", citations: citationPayload, grounding });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        send(controller, { type: "error", message: errorMessage });
        fullText += `\n\n[error: ${errorMessage}]`;
      } finally {
        controller.close();

        await db.insert(schema.chatMessages).values({
          chatSessionId: sessionId,
          role: "assistant",
          content: fullText,
          citations: citationPayload.length > 0 ? citationPayload : null,
          grounding,
        });
        await db.update(schema.chatSessions).set({ updatedAt: new Date() }).where(eq(schema.chatSessions.id, sessionId));

        if (isFirstMessage) {
          try {
            const title = await generateChatTitle(message);
            await db.update(schema.chatSessions).set({ title }).where(eq(schema.chatSessions.id, sessionId));
          } catch (error: unknown) {
            // Title generation is a nice-to-have — leave the default "New chat" title on failure.
            console.error("chat title generation failed:", error);
          }
        }
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
