import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BadgeCheck, CircleDashed, FileText, Globe2, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DisplayMessage, Grounding } from "@/components/chat/types";

export function MessageBubble({
  message,
  hasKnowledgeBase,
}: {
  message: DisplayMessage;
  hasKnowledgeBase: boolean;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end px-4">
        <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-sm text-accent-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  const showBadge = hasKnowledgeBase && Boolean(message.grounding) && message.content.length > 0;

  return (
    <div className="px-4">
      <div className="max-w-[85%]">
        {showBadge && <GroundingBadge grounding={message.grounding!} />}

        <div className="prose-chat text-sm text-foreground">
          {message.status ? (
            <RetrievalStatus status={message.status} />
          ) : message.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          ) : (
            <TypingDots />
          )}
        </div>

        {message.citations && message.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.citations.map((c, i) => (
              <span
                key={c.chunkId}
                title={c.snippet}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                <FileText className="size-3" />
                [{i + 1}] {c.documentName}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RetrievalStatus({ status }: { status: NonNullable<DisplayMessage["status"]> }) {
  const label =
    status.phase === "searching"
      ? status.kbCount === 1
        ? "Searching your knowledge base…"
        : `Searching ${status.kbCount} knowledge bases…`
      : status.count === 0
        ? "No relevant passages found — using general knowledge"
        : `Found ${status.count} relevant passage${status.count === 1 ? "" : "s"}`;

  return (
    <span className="inline-flex items-center gap-1.5 py-1 text-sm text-muted-foreground">
      {status.phase === "searching" ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <CircleDashed className="size-3.5" />
      )}
      {label}
    </span>
  );
}

const GROUNDING_META: Record<Grounding, { label: string; className: string; Icon: typeof BadgeCheck }> = {
  full: {
    label: "Fully grounded",
    className: "bg-primary/10 text-primary",
    Icon: BadgeCheck,
  },
  partial: {
    label: "Partially grounded",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  general: {
    label: "General knowledge",
    className: "bg-muted text-muted-foreground",
    Icon: Globe2,
  },
};

function GroundingBadge({ grounding }: { grounding: Grounding }) {
  const { label, className, Icon } = GROUNDING_META[grounding];
  return (
    <span className={cn("mb-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", className)}>
      <Icon className="size-3" />
      {label}
    </span>
  );
}

function TypingDots() {
  return (
    <span className={cn("inline-flex items-center gap-1 py-1")}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}
