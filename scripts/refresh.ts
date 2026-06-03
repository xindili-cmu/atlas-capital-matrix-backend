// Phase 2 — the weekly refresh worker (the AIHOT-equivalent core).
// Reads offices from Postgres, verifies each one's recent climate/frontier deals via the
// Claude verification agent (run CONCURRENTLY = parallel sub-agents), applies the gate
// (Inferred -> Pending, never published), writes provenance + updates activity_90d, and
// logs the run to the Changelog. Schedule it weekly with cron (see README §Phase 2).
//
//   npm run refresh -- --dry-run            # show planned writes, touch nothing
//   npm run refresh -- --limit 5            # only the first 5 offices (smoke test)
//   npm run refresh -- --concurrency 6      # parallel verification calls (default 6)
//
import { prisma } from "../src/db.js";
import { verifyOffice, scoutNewOffices, type OfficeFindings, type Confidence } from "../src/anthropic.js";
import { scoreOffices } from "../src/score.js"; // same formula the API uses
import { isAtlasMember } from "../src/atlas-allowlist.js"; // canonical Atlas-ecosystem tag

// ── flags ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
const DRY = flag("dry-run");
const LIMIT = val("limit", 0);            // 0 = all
const CONCURRENCY = val("concurrency", 6); // cap on simultaneous verification calls
const SCOUT = !flag("no-scout");           // scout for new entrants (on by default)
const LIST_SIZE = val("list-size", 100);   // how many offices stay on the public list

// ── concurrency pool (no extra deps): N workers pull from a shared queue ──────
async function mapPool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { console.error(`  ! verify failed for item ${i}:`, (e as Error).message); out[i] = null as any; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function statusFor(conf: Confidence): "Published" | "Pending" {
  return conf === "Inferred" ? "Pending" : "Published"; // the gate
}

// Prisma filter: only Published investments count toward score/breadth (mirrors server.ts).
const PUBLISHED = { status: "Published" as const };

async function main() {
  let offices = await prisma.office.findMany({ orderBy: { name: "asc" } });
  if (LIMIT > 0) offices = offices.slice(0, LIMIT);
  console.log(`Refresh start — ${offices.length} offices, concurrency ${CONCURRENCY}${DRY ? " (DRY RUN, no writes)" : ""}`);

  const run = DRY ? null : await prisma.run.create({ data: { notes: "Phase 2 weekly refresh" } });
  let created = 0, published = 0, quarantined = 0, kept = 0;

  const findings = await mapPool(offices, CONCURRENCY, async (o) => {
    const f = await verifyOffice(o.name, o.principal);
    console.log(`  ✓ ${o.name}: ${f.deals.length} deals, activity_90d=${f.activity_90d}`);
    return { officeId: o.id, ...f } as OfficeFindings & { officeId: string };
  });

  for (const f of findings) {
    if (!f) continue;

    // update activity_90d (the field that moves the ranking)
    if (!DRY) await prisma.office.update({ where: { id: f.officeId }, data: { activity90d: f.activity_90d } });

    for (const d of f.deals) {
      const status = statusFor(d.confidence);
      const company = DRY ? null : await prisma.company.upsert({
        where: { name: d.company }, update: {},
        create: { name: d.company, type: d.is_fund ? "fund" : "company" },
      });

      // does this office->company edge already exist?
      const existing = DRY ? null : await prisma.investment.findFirst({
        where: { officeId: f.officeId, companyId: company!.id },
      });

      // ── guardrails (match the refresh skill) ──────────────────────────────
      // 1. Never downgrade an already-Published, sourced edge to Pending/Inferred on a weak pass.
      if (existing && existing.status === "Published" && existing.sourceUrl && status === "Pending") {
        kept++; console.log(`    · kept (won't downgrade): ${f.office} -> ${d.company}`); continue;
      }
      // 2. Never overwrite a good source_url with an empty one.
      const sourceUrl = d.source_url ?? existing?.sourceUrl ?? null;

      if (DRY) {
        console.log(`    [dry] ${existing ? "update" : "create"} ${status.padEnd(9)} ${f.office} -> ${d.company} (${d.confidence}${d.source_url ? ", sourced" : ", no source"})`);
        created += existing ? 0 : 1; status === "Published" ? published++ : quarantined++;
        continue;
      }

      if (existing) {
        await prisma.investment.update({
          where: { id: existing.id },
          data: {
            amountUsdM: d.amount_usd_m ?? existing.amountUsdM, confidence: d.confidence, status,
            sourceUrl, sourceName: d.source_name ?? existing.sourceName,
            verifiedAt: status === "Published" ? new Date() : existing.verifiedAt,
          },
        });
      } else {
        await prisma.investment.create({
          data: {
            officeId: f.officeId, companyId: company!.id, amountUsdM: d.amount_usd_m,
            confidence: d.confidence, status, sourceUrl, sourceName: d.source_name,
            verifiedAt: status === "Published" ? new Date() : null,
          },
        });
        created++;
      }
      // provenance trail
      if (sourceUrl) await prisma.source.create({
        data: { investmentId: existing?.id ?? (await prisma.investment.findFirst({ where: { officeId: f.officeId, companyId: company!.id } }))!.id,
                url: sourceUrl, outlet: d.source_name, verdict: status === "Published" ? "confirmed" : "inconclusive" },
      });
      status === "Published" ? published++ : quarantined++;
    }
  }

  // ── Scout new entrants ───────────────────────────────────────────────────
  let added = 0;
  const promoted: string[] = [], demoted: string[] = [];
  const atlasEntrants: string[] = []; // scouted NEW offices that are on the Atlas allowlist
  if (SCOUT) {
    const existingNames = (await prisma.office.findMany({ select: { name: true } })).map((o) => o.name);
    const scouted = await scoutNewOffices(existingNames);
    console.log(`  scouted ${scouted.length} candidate new office(s)`);
    for (const s of scouted) {
      const verified = s.deals.filter((d) => d.confidence !== "Inferred" && d.source_url);
      if (verified.length === 0) { console.log(`    · skip (unverified): ${s.office}`); continue; }
      const atlas = isAtlasMember(s.office, s.principal); // on the Atlas coalition allowlist?
      if (atlas) atlasEntrants.push(s.office);
      if (DRY) { console.log(`    ${atlas ? "★ [dry] add NEW (ATLAS ecosystem)" : "[dry] add NEW"}: ${s.office} (${verified.length} verified deal(s))`); added++; continue; }
      const office = await prisma.office.create({
        data: { name: s.office, principal: s.principal, category: s.category, hq: s.hq,
                atlasMember: atlas,
                activity90d: s.activity_90d, listed: false, note: s.notes },
      });
      for (const d of s.deals) {
        const company = await prisma.company.upsert({ where: { name: d.company }, update: {}, create: { name: d.company, type: d.is_fund ? "fund" : "company" } });
        const status = d.confidence === "Inferred" ? "Pending" : "Published";
        const inv = await prisma.investment.create({ data: { officeId: office.id, companyId: company.id, amountUsdM: d.amount_usd_m, confidence: d.confidence, status, sourceUrl: d.source_url, sourceName: d.source_name, verifiedAt: status === "Published" ? new Date() : null } });
        if (d.source_url) await prisma.source.create({ data: { investmentId: inv.id, url: d.source_url, outlet: d.source_name, verdict: status === "Published" ? "confirmed" : "inconclusive" } });
      }
      added++; console.log(`    ${atlas ? "★ added (ATLAS ECOSYSTEM member!)" : "+ added"}: ${s.office}`);
    }
  }

  // ── Churn: rank ALL offices by the shared score (activity + capital + breadth), keep top LIST_SIZE listed ──
  const pool = await prisma.office.findMany({ include: { investments: { where: PUBLISHED } } });
  const ranked = scoreOffices(pool).sort((a, b) => b.score - a.score);
  const keep = new Set(ranked.slice(0, LIST_SIZE).map((r) => r.id));
  for (const r of ranked) {
    const should = keep.has(r.id);
    if (r.listed !== should) {
      (should ? promoted : demoted).push(r.name);
      if (!DRY) await prisma.office.update({ where: { id: r.id }, data: { listed: should } });
    }
  }
  console.log(`  churn: +${added} new · promoted ${promoted.length} · demoted ${demoted.length} · listed ${Math.min(LIST_SIZE, ranked.length)}/${ranked.length}`);
  if (promoted.length) console.log(`    ↑ promoted: ${promoted.join(", ")}`);
  if (demoted.length) console.log(`    ↓ demoted:  ${demoted.join(", ")}`);
  if (atlasEntrants.length) console.log(`    ★ NEW ATLAS-ECOSYSTEM members entered this run: ${atlasEntrants.join(", ")}`);

  if (run) await prisma.run.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), nNew: created, nVerified: published, nQuarantined: quarantined,
            notes: `Phase 2 refresh — ${published} published, ${quarantined} quarantined, ${kept} kept; churn +${added} new (${atlasEntrants.length} Atlas), ${promoted.length} promoted, ${demoted.length} demoted${atlasEntrants.length ? ` [Atlas entrants: ${atlasEntrants.join("; ")}]` : ""}` },
  });

  console.log(`\nRefresh done${DRY ? " (DRY RUN)" : ""}: ${created} new edges · ${published} published · ${quarantined} quarantined · ${kept} kept.`);
  if (DRY) console.log("No database changes were made.");
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
