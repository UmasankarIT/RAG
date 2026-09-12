"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { KbScope } from "@/components/chat/types";

export interface ChatSessionSummary {
  id: string;
  title: string;
  knowledgeBaseScope: KbScope;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

interface AppDataValue {
  sessions: ChatSessionSummary[];
  knowledgeBases: KnowledgeBaseSummary[];
  loadingSessions: boolean;
  refreshSessions: () => Promise<void>;
  refreshKnowledgeBases: () => Promise<void>;
}

const AppDataContext = createContext<AppDataValue | null>(null);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/chat-sessions");
    const data: { ok: boolean; data?: ChatSessionSummary[] } = await res.json();
    if (data.ok && data.data) setSessions(data.data);
    setLoadingSessions(false);
  }, []);

  const refreshKnowledgeBases = useCallback(async () => {
    const res = await fetch("/api/knowledge-bases");
    const data: { ok: boolean; data?: KnowledgeBaseSummary[] } = await res.json();
    if (data.ok && data.data) setKnowledgeBases(data.data);
  }, []);

  useEffect(() => {
    void refreshSessions();
    void refreshKnowledgeBases();
  }, [refreshSessions, refreshKnowledgeBases]);

  return (
    <AppDataContext.Provider
      value={{ sessions, knowledgeBases, loadingSessions, refreshSessions, refreshKnowledgeBases }}
    >
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppDataValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error("useAppData must be used within AppDataProvider");
  return ctx;
}
