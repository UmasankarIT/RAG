# L2G RAG (simple build)

A minimal visual RAG for an ophthalmology education platform. No GPU required.

Pages are never text-extracted for the answer. Each PDF page is rasterized to an
image; Gemini writes a short **description** of each page, and that description is
embedded for search. When a question comes in, we find the closest pages and send
the real **page images** to Gemini to answer — so the figures still drive the answer.

> The describe-then-embed step is a no-GPU stand-in for ColPali. Swap in true
> visual embeddings later when a GPU is available.

## Pipeline

```
Ingest:  PDF ──rasterize──> page images ──Gemini describe──> text ──embed──> pgvector
Ask:     question ──embed──> cosine search ──> top 3 pages ──> page IMAGES ──Gemini──> answer + citations
```

## Setup

```bash
npm install
cp .env.example .env        # add your GEMINI_API_KEY

docker compose up -d postgres   # Postgres 17 + pgvector
npm run db:push                 # create the schema
```

## Ingest

```bash
npm run ingest -- path/to/textbook.pdf --source-id glaucoma-101 --title "Glaucoma"
```

Re-ingesting the same `--source-id` updates its pages in place.

## Run

```bash
npm run dev
```

Ask a question:

```bash
curl -X POST localhost:3000/query \
  -H 'content-type: application/json' \
  -d '{"question": "Why does IOP rise in angle closure?"}'
```

## Layout

```
src/
  config.ts        env validation, embedding dimension
  db/              Drizzle schema + connection (pages table)
  gemini.ts        describe / embed / answer — the only Gemini calls
  ingest/          rasterize -> describe -> embed -> store
  retrieve.ts      embed question -> cosine search
  server.ts        Fastify API (/query, /health)
```

## Not built yet (the full flowchart)

ColPali visual embeddings, two-stage retrieval (HNSW + MaxSim), S3 storage, OCR,
KN-node structuring, mode router (Teach/Assess/Feedback), learner state, and the
governance check. This build is just the retrieval-and-answer spine.
