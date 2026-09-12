import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * The embedding model's output dimension. Defined locally (not imported from
 * config.ts) so drizzle-kit can load this schema without booting full env
 * validation (which requires ANTHROPIC_API_KEY, irrelevant to a schema push).
 * Keep in sync with EMBEDDING_DIM in config.ts.
 */
const EMBEDDING_DIM = 384;

// ---------------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// KNOWLEDGE BASES + DOCUMENTS (the RAG corpus, per user)
// ---------------------------------------------------------------------------

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("kb_user").on(t.userId)],
);

/** 'processing' while text is being extracted/chunked/embedded, then 'ready' or 'failed'. */
export const DOCUMENT_STATUSES = ["processing", "ready", "failed"] as const;

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    /** Object key in the Supabase Storage bucket — DB stores the key, not the bytes. */
    storageKey: text("storage_key").notNull(),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull().default("processing"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_kb").on(t.knowledgeBaseId)],
);

/**
 * One chunk of extracted document text plus its embedding. `knowledgeBaseId`
 * is denormalized from documents so retrieval can filter by it directly
 * without a join on every search.
 */
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // HNSW only indexes the vector column itself (same pattern as the old
    // `pages_coarse_hnsw` index); the knowledgeBaseId filter in every query
    // is served by the plain btree index below instead — Postgres combines
    // the two via a bitmap scan.
    index("chunk_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunk_kb").on(t.knowledgeBaseId),
    index("chunk_document").on(t.documentId),
  ],
);

// ---------------------------------------------------------------------------
// CHAT (sessions persist per user; messages carry the full context window)
// ---------------------------------------------------------------------------

/**
 * Which knowledge bases a session is grounded in:
 *   "all"      — every knowledge base the user owns (the default — searches
 *                everything, no setup required for a new chat)
 *   "selected" — only the knowledge bases listed in chatSessionKnowledgeBases
 *   "none"     — general chat, no RAG context at all
 * Fixed at session creation (see composer's knowledgeBaseLocked) — a
 * session's scope never changes mid-conversation, so retrieval is always
 * consistent with what was already discussed.
 */
export const KB_SCOPES = ["all", "selected", "none"] as const;

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    knowledgeBaseScope: text("knowledge_base_scope", { enum: KB_SCOPES }).notNull().default("all"),
    /** Auto-derived from the first user message; renameable. */
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user").on(t.userId, t.updatedAt)],
);

/** Which specific knowledge bases a "selected"-scope session searches. */
export const chatSessionKnowledgeBases = pgTable(
  "chat_session_knowledge_bases",
  {
    chatSessionId: uuid("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("session_kb_pair").on(t.chatSessionId, t.knowledgeBaseId),
    index("session_kb_session").on(t.chatSessionId),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatSessionId: uuid("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /** [{documentId, documentName, chunkId, snippet}] — which chunks grounded this answer. */
    citations: jsonb("citations"),
    /**
     * How much of an assistant answer actually came from cited passages —
     * computed deterministically server-side (see classifyGrounding in
     * app/api/chat/route.ts), not self-reported by the model. Null for user
     * messages.
     */
    grounding: text("grounding", { enum: ["full", "partial", "general"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_session").on(t.chatSessionId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// RELATIONS (for query-builder convenience, e.g. db.query.chatSessions.findMany)
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  knowledgeBases: many(knowledgeBases),
  chatSessions: many(chatSessions),
}));

export const knowledgeBasesRelations = relations(knowledgeBases, ({ one, many }) => ({
  user: one(users, { fields: [knowledgeBases.userId], references: [users.id] }),
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  knowledgeBase: one(knowledgeBases, {
    fields: [documents.knowledgeBaseId],
    references: [knowledgeBases.id],
  }),
  chunks: many(documentChunks),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, { fields: [documentChunks.documentId], references: [documents.id] }),
}));

export const chatSessionsRelations = relations(chatSessions, ({ many }) => ({
  messages: many(chatMessages),
  knowledgeBaseLinks: many(chatSessionKnowledgeBases),
}));

export const chatSessionKnowledgeBasesRelations = relations(chatSessionKnowledgeBases, ({ one }) => ({
  session: one(chatSessions, { fields: [chatSessionKnowledgeBases.chatSessionId], references: [chatSessions.id] }),
  knowledgeBase: one(knowledgeBases, {
    fields: [chatSessionKnowledgeBases.knowledgeBaseId],
    references: [knowledgeBases.id],
  }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  session: one(chatSessions, { fields: [chatMessages.chatSessionId], references: [chatSessions.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type KnowledgeBase = typeof knowledgeBases.$inferSelect;
export type NewKnowledgeBase = typeof knowledgeBases.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentChunk = typeof documentChunks.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
