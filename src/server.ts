import Fastify from "fastify";
import cors from "@fastify/cors";
import { prisma } from "./db.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true }); // public read API

// ── Scoring (proposal §8). activity weight 0 until Phase 2 feeds real activity_90d.
const W = { activity: 0.0, capital: 0.58, breadth: 0.42 };
// TODO (proposal §8): guard against one huge non-climate figure (e.g. SpaceX $10B)
// dominating — cap or log-scale capital before normalising.
function scoreOffices<T extends { activity90d: number; investments: { amountUsdM: number | null }[] }>(offices: T[]) {
  const capital = offices.map((o) => o.investments.reduce((s, i) => s + (i.amountUsdM ?? 0), 0));
  const breadth = offices.map((o) => o.investments.length);
  const activity = offices.map((o) => o.activity90d ?? 0);
  const max = (a: number[]) => Math.max(1, ...a);
  const mc = max(capital), mb = max(breadth), ma = max(activity);
  const sw = W.activity + W.capital + W.breadth;
  return offices.map((o, i) => ({
    ...o,
    capitalUsdM: capital[i],
    breadth: breadth[i],
    score: Math.round(((W.activity * activity[i]) / ma + (W.capital * capital[i]) / mc + (W.breadth * breadth[i]) / mb) / sw * 100),
  }));
}

// Public endpoints serve Published investments only — the gate.
const PUBLISHED = { status: "Published" as const };

app.get("/api/offices", async (req) => {
  const q = req.query as Record<string, string | undefined>;
  const where: any = {};
  if (q.category) where.category = q.category;
  if (q.atlas_member) where.atlasMember = /^(y|true|1)/i.test(q.atlas_member);
  if (q.q) where.OR = [
    { name: { contains: q.q, mode: "insensitive" } },
    { principal: { contains: q.q, mode: "insensitive" } },
    { hq: { contains: q.q, mode: "insensitive" } },
  ];
  const offices = await prisma.office.findMany({
    where,
    include: { investments: { where: PUBLISHED, include: { company: true } } },
  });
  let scored = scoreOffices(offices).sort((a, b) => b.score - a.score);
  if (q.confidence) scored = scored.filter((o) => o.investments.some((i) => i.confidence === q.confidence));
  return scored.map((o, idx) => ({
    rank: idx + 1,
    score: o.score,
    name: o.name,
    principal: o.principal,
    aum: o.aumText,
    aum_confidence: o.aumConfidence,
    aum_source: o.aumSource,
    category: o.category,
    hq: o.hq,
    atlas_member: o.atlasMember,
    note: o.note,
    activity_90d: o.activity90d,
    capital_usd_m: o.capitalUsdM,
    companies: o.investments.map((i) => ({
      name: i.company.name, type: i.company.type, amt: i.amountUsdM ?? 0,
      confidence: i.confidence, source_url: i.sourceUrl,
    })),
  }));
});

app.get("/api/companies", async () => {
  const companies = await prisma.company.findMany({
    include: { investments: { where: PUBLISHED, include: { office: true } } },
  });
  return companies
    .map((c) => ({
      name: c.name, type: c.type, sector: c.sector,
      backers: c.investments.map((i) => ({ office: i.office.name, amt: i.amountUsdM ?? 0, confidence: i.confidence })),
    }))
    .filter((c) => c.backers.length > 0)
    .sort((a, b) => b.backers.length - a.backers.length);
});

app.get("/api/graph", async () => {
  const investments = await prisma.investment.findMany({
    where: PUBLISHED, include: { office: true, company: true },
  });
  const nodes = new Map<string, any>();
  const links: any[] = [];
  for (const inv of investments) {
    const fid = "fo::" + inv.office.name;
    if (!nodes.has(fid)) nodes.set(fid, { id: fid, label: inv.office.name, type: "fo", cat: inv.office.category, atlas: inv.office.atlasMember });
    const cid = "co::" + inv.company.name;
    if (!nodes.has(cid)) nodes.set(cid, { id: cid, label: inv.company.name, type: inv.company.type, deg: 0 });
    nodes.get(cid).deg++;
    links.push({ source: fid, target: cid, amt: inv.amountUsdM ?? 0 });
  }
  return { nodes: [...nodes.values()], links };
});

app.get("/api/changelog", async () => {
  return prisma.run.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
});

// Sheet-compatible CSV mirror. Lets the existing HTML page connect by simply pointing its
// SHEET_CSV_URL at this endpoint — no change to the page's JS. Emits the same columns the
// Google Sheet did. By default returns ALL rows (so the page looks identical, Inferred rows
// badged as today); add ?gate=1 to serve only Published (strict gate) rows.
app.get("/api/offices.csv", async (req, reply) => {
  const gate = Boolean((req.query as Record<string, string>).gate);
  const offices = await prisma.office.findMany({
    include: { investments: { where: gate ? PUBLISHED : undefined, include: { company: true } } },
  });
  const cols = ["rank","family_office","principal","aum_networth","aum_confidence","aum_source","hq","category","atlas_member","companies_backed","mapped_raise_usd_m","activity_90d","confidence","source_url","note"];
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const scored = scoreOffices(offices).sort((a, b) => b.score - a.score);
  const lines = [cols.join(",")];
  scored.forEach((o: any, i: number) => {
    const cb = o.investments.map((inv: any) => `${inv.company.name} ($${inv.amountUsdM ?? 0}M)`).join("; ");
    const conf = o.investments[0]?.confidence ?? "Reported";
    const src = o.investments[0]?.sourceUrl ?? "#";
    const cap = o.investments.reduce((s: number, inv: any) => s + (inv.amountUsdM ?? 0), 0);
    lines.push([i + 1, o.name, o.principal, o.aumText, o.aumConfidence, o.aumSource, o.hq, o.category,
      o.atlasMember ? "Y" : "N", cb, cap, o.activity90d, conf, src, o.note].map(esc).join(","));
  });
  reply.header("content-type", "text/csv; charset=utf-8").send(lines.join("\n"));
});

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`API on :${port}`));
