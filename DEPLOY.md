# DEPLOY — Atlas Capital Matrix backend → live page

This is the "I am your technical owner, do exactly these steps" guide. Read §0 first — you
may not need the backend yet.

---

## 0. Do you actually need the backend right now? (honest answer)

**No, not to publish the page.** Your HTML already reads live data from the Google Sheet.
To put the page online you only need to host the HTML (Netlify) — the Sheet is the database.
That path has **zero servers, near-zero cost, nothing to maintain.**

The backend (Postgres + API + the weekly verification worker) is the *automation upgrade*.
Deploy it only when you want the Phase-2 worker to refresh/verify data on a schedule instead
of editing the Sheet. It costs money and needs an owner (you). So:

| You want… | Do this | Cost / upkeep |
|---|---|---|
| The page public, data edited by hand in the Sheet | **§1 only** (Netlify + Sheet) | ~$0, none |
| The page public + automated weekly verification | **§1 + §2 + §3** (add Railway backend) | ~$5–15/mo + upkeep |

---

## 1. Host the page (Netlify) — do you need Netlify?

**Yes for the page, but only as a static host — and any static host works.** Netlify does
*not* run the Node backend or Postgres; it just serves your HTML file to the public, fast,
on a real URL. You already use it for the cities matrix, so stick with it.

Steps:
1. Go to app.netlify.com → **Add new site → Deploy manually**.
2. Drag in `Atlas_Capital_Matrix_Top100_FamilyOffices.html` (rename to `index.html` first so
   the root URL shows it).
3. Netlify gives you a public URL (e.g. `atlas-matrix.netlify.app`). Done — the page is live,
   reading your Google Sheet.

That's the whole "go live" path. If you never deploy the backend, you're finished here.
*(The backend below cannot go on Netlify — Netlify has no always-on Node server + Postgres +
cron. That's why it goes on Railway.)*

---

## 2. Deploy the backend (Railway)

Railway runs all three pieces the backend needs — Postgres, the API, and the weekly cron —
in one project, deployed straight from GitHub with no server config.

### 2a. Put the repo on GitHub (Atlas-owned)
1. Create a repo under the **Atlas** GitHub org (not your personal account): `atlas-capital-matrix-backend`.
2. Push this folder to it (`git init && git add . && git commit -m "init" && git push`).

### 2b. Create the Railway project
1. railway.com → **New Project → Deploy from GitHub repo** → pick the repo.
2. **Add a database:** in the project, **New → Database → PostgreSQL**. Railway auto-creates a
   `DATABASE_URL` variable and injects it into your service — you don't copy anything.
3. **Add the API key:** on the service → **Variables** → add `ANTHROPIC_API_KEY` = your
   **Atlas-owned** key (and optionally `ANTHROPIC_MODEL`). Only needed for the Phase-2 worker.
4. **Start command:** Settings → set start command to `npm start`. Railway runs `npm install`
   automatically.

### 2c. Initialise the database (one time)
In Railway, open the service shell (or run locally with the Railway `DATABASE_URL`):
```bash
npm install
npx prisma db push           # create the tables from schema
npm run seed                  # load the 100 audited rows from data/seed.csv
```
Then open `https://<your-service>.up.railway.app/api/offices.csv` — you should see CSV rows.
(`/health` should return `{ok:true}`; `/api/offices` returns JSON.)

### 2d. Schedule the weekly worker (optional, Phase 2)
In the project: **New → Cron** (or a separate service with a schedule), command:
```
npm run refresh
```
Schedule `0 9 * * 1` (Mondays 09:00). **First, test it safely:** run `npm run refresh -- --dry-run`
in the shell once and read the output before enabling the schedule.

---

## 3. Connect the page to the backend

Your page reads CSV from one line near the top of the HTML:

```js
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/.../gviz/tq?tqx=out:csv";
```

The backend exposes the **same CSV format** at `/api/offices.csv`, so connecting is a
one-line change — no other edit to the page:

```js
const SHEET_CSV_URL = "https://<your-service>.up.railway.app/api/offices.csv";
```

Re-deploy the HTML to Netlify (drag it in again). The page now reads from the backend instead
of the Sheet. Everything else — table, ranking, network graph — works unchanged, because the
column format is identical.

Notes:
- Want the strict gate on the public page (hide Inferred rows)? Use `…/api/offices.csv?gate=1`.
- The API already sends permissive CORS headers, so the browser can fetch it cross-origin.
- Fallback still works: if the backend URL is unreachable, set `SHEET_CSV_URL` back to the
  Sheet URL (or `""` to use the page's built-in snapshot). Nothing breaks.

---

## 4. Which data source should the page point at?

You now have three possible sources for the same page — pick one for `SHEET_CSV_URL`:

| Source | URL | When |
|---|---|---|
| **Google Sheet** | the gviz CSV URL | Simplest; hand-edited; no backend. **Default/recommended for now.** |
| **Backend CSV** | `…railway.app/api/offices.csv` | Once the backend + weekly worker are live and you want automated data. |
| **Built-in snapshot** | `""` (empty) | Offline safety net. |

They're interchangeable — switching is just changing that one line.

---

## 5. Cost & ownership (the honest part)

- **Netlify (page):** free tier is plenty for a static page.
- **Railway (backend):** usage-based, roughly **$5–15/month** for a small Postgres + API +
  cron at this scale. Set a budget alert.
- **Anthropic key (worker):** each weekly run makes ~100 web-search calls — a recurring,
  unattended cost. Use an **Atlas-owned** key with a spend cap, never a personal one.
- **Ownership:** the GitHub repo, Railway project, Netlify site, and API key must all live
  under **Atlas accounts**, or the whole thing breaks when an individual leaves. This is the
  same §1-ownership rule from the handoff doc.
- **Maintenance:** the backend is a standing service. If no one is watching it, keep it off
  and run on the Google Sheet (the §0 path) — that needs no upkeep.
