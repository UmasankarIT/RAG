"use client";

import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { KbPicker } from "@/components/chat/kb-picker";
import type { KbSelection } from "@/components/chat/types";

interface ComposerProps {
  onSend: (text: string) => void;
  disabled: boolean;
  kbSelection: KbSelection;
  onKbSelectionChange: (next: KbSelection) => void;
  knowledgeBaseLocked: boolean;
}

export function Composer({
  onSend,
  disabled,
  kbSelection,
  onKbSelectionChange,
  knowledgeBaseLocked,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="mb-2 flex justify-center">
        <KbPicker value={kbSelection} onChange={onKbSelectionChange} disabled={knowledgeBaseLocked} />
      </div>
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          placeholder="Message the assistant…"
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
          aria-label="Send message"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}
