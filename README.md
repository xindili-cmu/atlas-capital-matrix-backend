# Atlas Capital Matrix — Backend (Phase 1)

Database + read API for the Top-100 Family Offices matrix. This is **Phase 1** of the
backend proposal: it stands up Postgres + a REST API and seeds it from the audited
100-row CSV, then the existing matrix page can point at this API instead of the Google
Sheet CSV. **No automation/ingestion yet** — that's Phase 2.

> ⚠️ **Ownership dependency.** This is a standing service. It needs a technical owner to
> deploy and maintain it (server, database, costs). Per the proposal's §11/§12, do not run
> this in production until Atlas assigns that owner, and host it under an **Atlas-owned**
> account, never a personal one. The code is ready; the operational commitment is the gate.

## What's here

```
atlas-capital-matrix-backend/
├── prisma/schema.prisma   # offices · companies · investments(edges) · sources · runs
├── src/
│   ├── db.ts              # Prisma client
│   └── server.ts          # Fastify REST API (/api/offices, /companies, /graph, /changelog)
├── scripts/seed.ts        # import data/seed.csv → Postgres
├── data/seed.csv          # the audited 100-row export (source of truth for Phase 1)
├── .env.example           # DATABASE_URL
└── package.json
```

## Quick start (local)

```bash
# 1. Postgres running locally (or a hosted URL)
cp .env.example .env          # set DATABASE_URL
npm install
npx prisma migrate dev --name init   # create tables
npm run seed                  # load data/seed.csv
npm run dev                   # API on http://localhost:3000
```

Then point the matrix page at it: in `Atlas_Capital_Matrix_Top100_FamilyOffices.html`
set `SHEET_CSV_URL = ""` and add a small fetch to `http://<host>/api/offices` (or repoint
the loader). The API returns the same fields the page already understands.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/offices` | Ranked offices (Atlas Score) with their published investments. Filters: `category`, `confidence`, `atlas_member`, `q`, `since` |
| `GET /api/companies` | Companies/funds and their backers |
| `GET /api/graph` | `{ nodes, links }` for the network graph |
| `GET /api/changelog` | Seed/refresh runs and what changed |

**The gate:** public endpoints return only investments with `status = Published`.
Anything seeded as `Inferred` is stored as `Pending` and never served publicly — same
quarantine rule as the Sheet workflow.

## Scoring

`score = 0.58·capital + 0.42·breadth` (activity weight 0 until Phase 2 feeds real
`activity_90d`). Computed in `server.ts` so weights are easy to tune. See the proposal §8;
the SpaceX-style single-figure distortion guard is a TODO noted in the code.

## Phase-1 simplifications (hardening for later)

- `category` and `confidence` are stored as strings, not DB enums — fine for now.
- The CSV carries one office-level `confidence`/`source_url`; the seed applies it to each
  parsed investment. True per-deal provenance + the `via_fund` (office→fund→company) edges
  are a Phase-2 enrichment.
- No auth on the API (read-only, public data). Add a key on any write endpoints in Phase 2.

---

## Phase 2 — the weekly verification worker (`npm run refresh`)

The AIHOT-equivalent core: instead of editing data by hand, a worker researches each
office's recent climate/frontier deals, **verifies** them against real sources, applies the
gate, and writes the results back to Postgres. The public API then serves the fresh,
verified data automatically.

### What it does
1. Reads every office from the DB.
2. Verifies them **concurrently** — one `verifyOffice()` call per office (the "parallel
   sub-agents"), capped by `--concurrency` (default 6). Each call uses Claude with the
   server-side `web_search` tool and a system prompt that encodes the gate (`src/anthropic.ts`).
3. Routes each returned deal by confidence: **Confirmed/Reported → `Published`**,
   **Inferred (or no real source) → `Pending`** (quarantined, never public).
4. Updates each office's `activity_90d` (the field that moves the ranking), writes a
   `Source` provenance row per verified deal, and logs the run to `Run` (the Changelog).

### Guardrails (built in)
- Never downgrades an already-`Published`, sourced edge to `Pending` on a weak pass.
- Never overwrites a good `source_url` with an empty one.
- The model is not trusted to self-police: `anthropic.ts` re-checks every deal and forces
  `Inferred` if there is no real `https` source — so nothing reaches `Published` without a link.

### Run it
```bash
# 1. add your Atlas-owned key to .env:  ANTHROPIC_API_KEY=sk-ant-...
npm run refresh -- --dry-run        # show planned writes, change nothing  ← always start here
npm run refresh -- --limit 5        # smoke-test on 5 offices
npm run refresh                     # full run (writes to the DB)
```

### Schedule it (weekly)
Family-office portfolios move slowly — weekly is plenty. Example cron (Mondays 09:00):
```cron
0 9 * * 1  cd /path/to/atlas-capital-matrix-backend && /usr/bin/npm run refresh >> refresh.log 2>&1
```

### Cost & ownership (read before enabling)
- Each run makes ~100 Claude calls with web search — a recurring, unattended cost. Set a
  budget cap on the Atlas key.
- The `ANTHROPIC_API_KEY` must be **Atlas-owned**, never a personal key (it bills and it
  outlives whoever set it up).
- This is the piece the proposal (§11) flags as maintenance-dependent: it researches and
  writes unattended. Keep an eye on the `Run`/Changelog and the `Pending` rows. If no one
  owns it, **leave it off and keep editing the Sheet** — the read API (Phase 1) still works.

### Not yet wired (deliberate next steps)
- `via_fund` (office→fund→company) edges: the schema supports them; the worker currently
  records direct office→company/fund edges only.
- A `Pending`-review API endpoint for a human to promote quarantined rows (today: inspect
  the table directly).
- Ingestion from RSS/filings (the worker is search-driven; feed pulls are a later add).
