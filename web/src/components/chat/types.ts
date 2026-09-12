export interface Citation {
  documentId: string;
  documentName: string;
  knowledgeBaseName: string;
  chunkId: string;
  snippet: string;
}

export type Grounding = "full" | "partial" | "general";

export type KbScope = "all" | "selected" | "none";

/** Which knowledge bases a session searches — "selected" is meaningful only with a non-empty ids array. */
export interface KbSelection {
  scope: KbScope;
  ids: string[];
}

export interface RetrievalStatus {
  phase: "searching" | "searched";
  /** Number of knowledge bases being searched — only present on "searching". */
  kbCount?: number;
  /** Number of passages found — only present on "searched". */
  count?: number;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[] | null;
  grounding?: Grounding | null;
  /** Present only on the in-flight assistant message, before its first text delta arrives. */
  status?: RetrievalStatus | null;
}

/** Line shape of the /api/chat NDJSON response body — one JSON object per line. */
export type ChatStreamEvent =
  | { type: "status"; phase: "searching"; kbCount: number }
  | { type: "status"; phase: "searched"; count: number }
  | { type: "delta"; text: string }
  | { type: "final"; citations: Citation[]; grounding: Grounding }
  | { type: "error"; message: string };
