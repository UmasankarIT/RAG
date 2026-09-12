"use client";

import { Check, ChevronDown, Database, Globe2, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app-data-context";
import type { KbSelection } from "@/components/chat/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface KbPickerProps {
  value: KbSelection;
  onChange: (next: KbSelection) => void;
  disabled?: boolean;
}

export function kbSelectionLabel(value: KbSelection, knowledgeBases: { id: string; name: string }[]): string {
  if (value.scope === "none") return "General chat (no knowledge base)";
  if (value.scope === "all") return "All knowledge bases";
  const names = value.ids.map((id) => knowledgeBases.find((kb) => kb.id === id)?.name ?? "…");
  if (names.length === 1) return names[0]!;
  return `${names.length} knowledge bases: ${names.join(", ")}`;
}

export function KbPicker({ value, onChange, disabled }: KbPickerProps) {
  const { knowledgeBases } = useAppData();

  function toggleKb(id: string) {
    if (value.scope !== "selected") {
      onChange({ scope: "selected", ids: [id] });
      return;
    }
    const nextIds = value.ids.includes(id) ? value.ids.filter((x) => x !== id) : [...value.ids, id];
    onChange(nextIds.length === 0 ? { scope: "none", ids: [] } : { scope: "selected", ids: nextIds });
  }

  const label = kbSelectionLabel(value, knowledgeBases);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          disabled={disabled}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-70"
        >
          <Database className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          {!disabled && <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuItem onSelect={() => onChange({ scope: "all", ids: [] })}>
          <Layers className="size-4" />
          <span className="flex-1">All knowledge bases</span>
          {value.scope === "all" && <Check className="size-4 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange({ scope: "none", ids: [] })}>
          <Globe2 className="size-4" />
          <span className="flex-1">General chat (no knowledge base)</span>
          {value.scope === "none" && <Check className="size-4 text-primary" />}
        </DropdownMenuItem>

        {knowledgeBases.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Or pick specific ones</p>
            {knowledgeBases.map((kb) => {
              const checked = value.scope === "selected" && value.ids.includes(kb.id);
              return (
                <DropdownMenuItem
                  key={kb.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleKb(kb.id);
                  }}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {checked && <Check className="size-3" />}
                  </span>
                  <span className="flex-1 truncate">{kb.name}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
