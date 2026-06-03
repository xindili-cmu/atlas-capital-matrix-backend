// Seed Postgres from data/seed.csv (the audited 100-row export).
// Parses each office row, splits `companies_backed` into investment edges, and applies
// the gate: Inferred deals are stored as status=Pending (never served publicly).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prisma } from "../src/db.js";
import { isAtlasMember } from "../src/atlas-allowlist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV = join(__dirname, "..", "data", "seed.csv");

// Minimal RFC-4180 CSV parser (handles quotes, commas, newlines in fields).
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let f = "", row: string[] = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; if (f !== "" || row.length) { row.push(f); rows.push(row); } f = ""; row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// "Twelve ($645M); Form Energy ($450M)" → [{name, amt}]
function parseCompanies(s: string) {
  return s.split(";").map((x) => x.trim()).filter(Boolean).map((part) => {
    const m = part.match(/^(.*?)\s*\(\$?([\d.]+)\s*([MB])?\)\s*$/i);
    if (m) { let amt = parseFloat(m[2]); if ((m[3] || "").toUpperCase() === "B") amt *= 1000; return { name: m[1].trim(), amt: Math.round(amt) }; }
    return { name: part, amt: 0 };
  });
}

async function main() {
  // Idempotency guard: only seed when the DB is empty, so this can run automatically on
  // every deploy (see railway.json preDeployCommand) without duplicating edges.
  const already = await prisma.investment.count();
  if (already > 0) {
    console.log(`Already seeded (${already} investments present) — skipping.`);
    return;
  }

  const grid = parseCSV(readFileSync(CSV, "utf8"));
  const head = grid[0].map((h) => h.trim().toLowerCase());
  const ix = (n: string) => head.indexOf(n);
  const run = await prisma.run.create({ data: { notes: "Phase 1 CSV seed" } });

  let nNew = 0, nQuarantined = 0;
  for (let r = 1; r < grid.length; r++) {
    const g = grid[r]; if (!g[ix("family_office")]) continue;
    const office = await prisma.office.upsert({
      where: { name: g[ix("family_office")].trim() },
      update: {},
      create: {
        name: g[ix("family_office")].trim(),
        principal: g[ix("principal")] || null,
        aumText: g[ix("aum_networth")] || null,
        aumConfidence: ix("aum_confidence") >= 0 ? g[ix("aum_confidence")] || null : null,
        aumSource: ix("aum_source") >= 0 ? g[ix("aum_source")] || null : null,
        category: g[ix("category")] || "Family Office",
        hq: g[ix("hq")] || null,
        atlasMember: isAtlasMember(g[ix("family_office")], ix("principal") >= 0 ? g[ix("principal")] : null),
        note: g[ix("note")] || null,
        activity90d: ix("activity_90d") >= 0 ? Number(g[ix("activity_90d")]) || 0 : 0,
      },
    });
    const confidence = (g[ix("confidence")] || "Reported").trim();      // office-level deal confidence
    const status = confidence === "Inferred" ? "Pending" : "Published"; // the gate
    const sourceUrl = g[ix("source_url")] || null;
    for (const c of parseCompanies(g[ix("companies_backed")] || "")) {
      const company = await prisma.company.upsert({
        where: { name: c.name }, update: {},
        create: { name: c.name, type: /fund|ventures|capital|partners/i.test(c.name) ? "fund" : "company" },
      });
      await prisma.investment.create({
        data: {
          officeId: office.id, companyId: company.id, amountUsdM: c.amt || null,
          confidence, status, sourceUrl,
          verifiedAt: status === "Published" ? new Date() : null,
        },
      });
      nNew++; if (status === "Pending") nQuarantined++;
    }
  }
  await prisma.run.update({ where: { id: run.id }, data: { finishedAt: new Date(), nNew, nVerified: nNew - nQuarantined, nQuarantined } });
  console.log(`Seeded ${nNew} investments (${nQuarantined} quarantined as Pending).`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
