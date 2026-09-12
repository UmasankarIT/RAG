import Groq from "groq-sdk";
import { config } from "./config";

/**
 * The chat-generation boundary — every LLM call in the app goes through here.
 * Groq (hosted, free tier, runs on their hardware — no local load, no
 * Anthropic key needed). Swappable later without touching any route/component — the
 * rest of the app only depends on `ChatTurn` and `streamChatReply`.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

let client: Groq | null = null;
function groq(): Groq {
  return (client ??= new Groq({ apiKey: config.GROQ_API_KEY }));
}

/** Stream the assistant's reply as text deltas, given a system prompt and prior turns. */
export async function* streamChatReply(system: string, messages: ChatTurn[]): AsyncGenerator<string> {
  const stream = await groq().chat.completions.create({
    model: config.GROQ_MODEL,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

/** One short, non-streaming call — used to auto-title a new chat session from its first message. */
export async function generateChatTitle(firstMessage: string): Promise<string> {
  const response = await groq().chat.completions.create({
    model: config.GROQ_MODEL,
    // GROQ_MODEL may be a "reasoning" model (e.g. gpt-oss) that thinks in a
    // separate `reasoning` channel before ever writing `content` — even at
    // the lowest effort level this still costs ~30-50 tokens, so the budget
    // has to cover reasoning + the actual short answer, not just the answer.
    // "none" is in the SDK's types but this API only actually accepts
    // low/medium/high — "low" is the closest to "don't overthink it".
    max_completion_tokens: 150,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "Generate a short chat title (3-6 words, no quotes, no trailing punctuation) summarizing the topic of the user's message. Reply with ONLY the title.",
      },
      { role: "user", content: firstMessage },
    ],
  });

  const text = response.choices[0]?.message?.content?.trim() ?? "";
  return text.slice(0, 80) || "New chat";
}

/**
 * One short, non-streaming call — classifies how grounded a just-generated
 * answer actually is. Deliberately a real (cheap) LLM judgment, not a regex
 * over the answer text: matching phrases like "doesn't cover" or "no
 * information about" is too brittle against natural phrasing variance (e.g.
 * an answer that cites a passage only to explain it's NOT relevant should
 * classify as "general", not "full" — a plain citation-count/keyword check
 * gets this wrong). Called only when at least one passage was retrieved.
 */
export async function classifyGroundingLLM(
  question: string,
  answer: string,
  context: string,
): Promise<"full" | "partial" | "general"> {
  const response = await groq().chat.completions.create({
    model: config.GROQ_MODEL,
    max_completion_tokens: 150,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content: `Classify how grounded an assistant's answer is in the reference passages it was given. Reply with EXACTLY one word, nothing else:
- full: the answer's substance actually came from the passages.
- partial: the passages answered some of the question, but the answer also relied on outside/general knowledge or left part of it unanswered.
- general: the passages didn't meaningfully help — including when the answer only cites a passage to explain it's NOT relevant, or declines to answer from it.`,
      },
      {
        role: "user",
        content: `Reference passages the assistant was given:\n${context}\n\nQuestion: ${question}\n\nAnswer: ${answer}\n\nReply with exactly one word: full, partial, or general.`,
      },
    ],
  });

  // Defensive substring match, not strict equality — even with reasoning
  // disabled, a model can still wrap the word in punctuation/a short phrase.
  const word = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
  if (word.includes("partial")) return "partial";
  if (word.includes("full")) return "full";
  return "general";
}
