# AI Tutor frontend

Next.js chat UI for the 3H Pedagogical Agent's Mode 3 (TEACH). Talks to the Fastify
backend in `../src/server.ts` via `POST /api/teach`.

## Run it

```
# terminal 1 — backend (from repo root)
npm run dev

# terminal 2 — frontend
cd frontend
npm run dev
```

Backend listens on `http://localhost:3000` (`PORT` in `.env`). Frontend runs on
`http://localhost:3001` and proxies `/api/*` to the backend (see `next.config.ts`,
override with `BACKEND_URL` if the backend runs elsewhere).

## Contract

Request:

```json
{ "learnerExtKey": "web-abc123", "topic": "acute angle closure" }
```

Response:

```json
{
  "ok": true,
  "data": {
    "answer": "text answer, [KN-14] citations inline",
    "citations": ["KN-14"],
    "unknownCitations": [],
    "usedVisual": true
  }
}
```

`learnerExtKey` is generated once per browser and stored in `localStorage` — there's
no auth yet. If the backend is unreachable or a topic has no reviewed knowledge nodes,
the UI shows an inline error instead of guessing.
