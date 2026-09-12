"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { BookOpen, LogOut, Menu, PanelLeftClose, PlusCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app-data-context";
import { groupByRecency } from "@/components/sidebar/group-by-recency";
import { SessionItem } from "@/components/sidebar/session-item";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { sessions, loadingSessions } = useAppData();
  const pathname = usePathname();
  const { data: authSession } = useSession();
  const grouped = groupByRecency(sessions);

  const initial = (authSession?.user?.name ?? authSession?.user?.email ?? "?").charAt(0).toUpperCase();

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex items-center gap-2 border-b border-border p-3 md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="flex size-9 items-center justify-center rounded-lg hover:bg-muted"
          aria-label="Open sidebar"
        >
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-medium">RAG Chatbot</span>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={cn(
          "z-50 flex h-dvh flex-col bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200",
          "fixed inset-y-0 left-0 w-72 -translate-x-full md:relative md:translate-x-0",
          mobileOpen && "translate-x-0",
          collapsed ? "md:w-16" : "md:w-72",
        )}
      >
        <div className="flex items-center justify-between p-3">
          {!collapsed && <span className="px-2 text-sm font-semibold">RAG Chatbot</span>}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCollapsed((c) => !c)}
              className="hidden size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-hover md:flex"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
            </button>
            <button
              onClick={() => setMobileOpen(false)}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-hover md:hidden"
              aria-label="Close sidebar"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="px-3">
          <Link
            href="/"
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-hover",
              collapsed && "md:justify-center md:px-0",
            )}
          >
            <PlusCircle className="size-4 shrink-0" />
            {!collapsed && "New chat"}
          </Link>
        </div>

        <nav className={cn("thin-scroll mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-3", collapsed && "md:hidden")}>
          {loadingSessions && <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</p>}
          {!loadingSessions && sessions.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No chats yet — start one above.</p>
          )}
          {grouped.map(([label, items]) => (
            <div key={label}>
              <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">{label}</p>
              <div className="space-y-0.5">
                {items.map((session) => (
                  <SessionItem key={session.id} session={session} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-1 border-t border-border p-3">
          <Link
            href="/knowledge-base"
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-hover",
              pathname === "/knowledge-base" && "bg-sidebar-active",
              collapsed && "md:justify-center md:px-0",
            )}
          >
            <BookOpen className="size-4 shrink-0" />
            {!collapsed && "Knowledge base"}
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-sidebar-hover",
                  collapsed && "md:justify-center",
                )}
              >
                <Avatar>
                  <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <span className="min-w-0 flex-1 truncate">
                    {authSession?.user?.name ?? authSession?.user?.email}
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuItem destructive onSelect={() => signOut({ callbackUrl: "/login" })}>
                <LogOut className="size-4" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
