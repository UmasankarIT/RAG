# Personal RAG Chatbot

A personal, multi-user RAG (retrieval-augmented generation) chatbot: sign in,
create knowledge bases, upload your own documents, and chat with an assistant
grounded in them — chat history persists per session, Gemini/ChatGPT-style.

Everything lives in [`web/`](web/) — a single Next.js app (TypeScript
end-to-end: frontend, API routes, DB access, ingestion, retrieval). Nothing
required to run it costs money: chat generation is Groq (hosted, free tier),
embeddings run locally (free, no key), and the database + uploaded files live
on Supabase (hosted, free tier) by default — or run Postgres locally via this
repo's `docker-compose.yml` instead, if you'd rather not use Supabase.

## Run it

```
cd web
npm install
cp .env.local.example .env.local   # fill in secrets — see comments in that file
npm run db:push                     # create tables
npm run dev
```

See [`web/README.md`](web/README.md) for app-specific details.
