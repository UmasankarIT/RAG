import { eq } from "drizzle-orm";
import { db, schema } from "./db";

export interface ScopedKnowledgeBase {
  id: string;
  name: string;
}

/**
 * Resolve a chat session's knowledgeBaseScope into the concrete list of
 * knowledge bases it actually searches — shared by the chat route (needs the
 * ids to retrieve against) and the session-detail route (needs them to show
 * the user which knowledge bases this session is scoped to).
 */
export async function resolveSessionKnowledgeBases(session: {
  id: string;
  userId: string;
  knowledgeBaseScope: (typeof schema.KB_SCOPES)[number];
}): Promise<ScopedKnowledgeBase[]> {
  if (session.knowledgeBaseScope === "none") return [];

  if (session.knowledgeBaseScope === "all") {
    return db
      .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
      .from(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.userId, session.userId));
  }

  return db
    .select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
    .from(schema.chatSessionKnowledgeBases)
    .innerJoin(schema.knowledgeBases, eq(schema.chatSessionKnowledgeBases.knowledgeBaseId, schema.knowledgeBases.id))
    .where(eq(schema.chatSessionKnowledgeBases.chatSessionId, session.id));
}
