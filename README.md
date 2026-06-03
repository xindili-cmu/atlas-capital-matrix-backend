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

`score = 0.40·activity + 0.35·capital + 0.25·breadth`, defined once in `src/score.ts` and
imported by **both** `server.ts` (the page ranking) and `refresh.ts` (the churn decision) so
they can never diverge. Capital is **log-scaled** so one huge figure (e.g. a $10B line) can't
dominate the axis and flatten everyone else. Weights live in `SCORE_WEIGHTS` — tune in one place.

`activity` is now weighted (it was 0 in Phase 1). This is what makes churn reward recency:
the worker writes a real `activity_90d` each run, so a stale office (no recent deals) sinks
and an active one rises. Until the first worker run, seeded `activity_90d` is a placeholder,
so the very first ranking is approximate.

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

---

## Phase 2.1 — dynamic churn (scout + promote/demote)

The weekly worker now keeps the list **fresh**, not fixed. Each run, after refreshing the
existing offices, it:

1. **Scouts** for NEW family offices / sovereign funds / corporate strategics (not VC) that
   have a *verifiable* recent climate/frontier deal — same gate, real source required. Only
   offices with ≥1 Confirmed/Reported deal are added; unverifiable candidates are skipped.
2. **Churns**: ranks ALL offices in the pool by Published capital + breadth and keeps the
   **top `--list-size` (default 100)** on the public list (`listed = true`). Offices that fall
   below are **demoted, not deleted** (`listed = false`) — they can climb back next week.

The public API/CSV/graph now serve only `listed = true` offices (add `?all=1` to `/api/offices`
to see the full pool including benched ones).

**Behaviour to expect:** because churn ranks by *verified* (Published) deals, the unverified
`Inferred` rows have score 0 and are the first to be demoted as verified new entrants come in.
So the list self-cleans toward fully-sourced offices over time — but its membership changes.

Flags: `--no-scout` (refresh existing only, no new entrants), `--list-size N` (default 100).
The `Run`/Changelog row records each run's `+new / promoted / demoted` counts.

**Ranking signal:** churn ranks by the shared `src/score.ts` formula, which now **includes
activity** (0.40 weight). So churn rewards recency: offices with recent verified deals rise
and can enter the top `LIST_SIZE`; offices with no activity in 90 days sink and drop off.
Membership genuinely changes week to week — that's the dynamic churn.
