"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatSessionSummary } from "@/components/app-data-context";
import { useAppData } from "@/components/app-data-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function SessionItem({ session }: { session: ChatSessionSummary }) {
  const router = useRouter();
  const params = useParams<{ sessionId?: string }>();
  const { refreshSessions } = useAppData();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const active = params?.sessionId === session.id;

  async function commitRename() {
    setRenaming(false);
    const trimmed = title.trim();
    if (!trimmed || trimmed === session.title) {
      setTitle(session.title);
      return;
    }
    await fetch(`/api/chat-sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    void refreshSessions();
  }

  async function handleDelete() {
    await fetch(`/api/chat-sessions/${session.id}`, { method: "DELETE" });
    void refreshSessions();
    if (active) router.push("/");
  }

  if (renaming) {
    return (
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTitle(session.title);
            setRenaming(false);
          }
        }}
        className="w-full rounded-lg border border-primary bg-card px-3 py-2 text-sm text-foreground outline-none"
      />
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg pr-1 transition-colors",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
    >
      <Link href={`/c/${session.id}`} className="min-w-0 flex-1 truncate px-3 py-2 text-sm text-sidebar-foreground">
        {session.title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-active group-hover:opacity-100",
              "data-[state=open]:opacity-100 data-[state=open]:bg-sidebar-active",
            )}
            aria-label="Chat options"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem destructive onSelect={handleDelete}>
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
