# RAG Chatbot (web)

A single Next.js app: frontend, API routes, auth, ingestion, and retrieval —
TypeScript end-to-end, no separate backend service. Chat generation runs on
Groq (hosted, free), embeddings run locally (MiniLM, free, no key), and both
the database and uploaded files live on Supabase (hosted, free) — nothing
required to run this app costs money or needs a credit card.

## Run it

```
cd web
npm install
cp .env.local.example .env.local
# fill in: DATABASE_URL (Supabase), AUTH_SECRET, GROQ_API_KEY,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — see comments in that file
npm run db:push                     # create tables
npm run dev
```

Open `http://localhost:1307` (the dev/start scripts run on port 1307), sign
up, create a knowledge base, upload a document, and start chatting.

Prefer a local Postgres over Supabase? `docker compose up -d` from the repo
root starts an isolated Postgres+pgvector container instead — point
`DATABASE_URL` at that (see `../docker-compose.yml`) rather than Supabase.

## Layout

- `src/app` — pages and API routes (App Router)
- `src/lib/db` — Drizzle schema + client
- `src/lib/auth.ts` / `auth.config.ts` — NextAuth (credentials) config, split
  into a Node-only full config and an edge-safe subset for middleware
- `src/lib/llm.ts` — chat-generation boundary (Groq, swappable)
- `src/lib/embeddings.ts` — embedding boundary (local MiniLM, swappable)
- `src/lib/storage.ts` — file-storage boundary (Supabase Storage, swappable)
- `src/lib/ingest` — file → text → chunks → embeddings pipeline
- `src/lib/retrieve.ts` — hybrid vector + full-text retrieval, multi-knowledge-base aware
- `src/components` — sidebar, chat UI, knowledge-base UI, shared UI primitives
