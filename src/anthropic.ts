// Phase 2 — verification agent.
// For ONE office, asks Claude (with the server-side web_search tool) to find its recent
// climate/frontier deals and return STRICT JSON. The verification gate (proposal §7) is
// encoded in the system prompt: a deal is only "Confirmed"/"Reported" if a real source
// names BOTH the office and the company; otherwise it is "Inferred" and the worker will
// quarantine it. One concurrent call per office = one "parallel sub-agent".
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Owner sets the exact model string in .env (model names change). Sensible default below.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

export type Confidence = "Confirmed" | "Reported" | "Inferred";

export interface VerifiedDeal {
  company: string;
  amount_usd_m: number | null;   // the OFFICE's stake if disclosed, else the round size (approx)
  confidence: Confidence;
  source_url: string | null;
  source_name: string | null;
  is_fund: boolean;              // is the target itself a fund/VC vehicle?
}

export interface OfficeFindings {
  office: string;
  deals: VerifiedDeal[];
  activity_90d: number;          // count of verified deals + notable news in last ~90 days
  notes: string;
}

const SYSTEM = `You verify climate & frontier-tech investments by a single family office / institutional investor for a public capital-matrix. Accuracy and traceability matter more than completeness — a public page relies on this.

RULES (the gate):
- Use web search to find leads, then rely on the actual source, not a guess.
- PRIMARY sources beat secondary: a company press release / the office's own site / a regulatory filing (SEC Form D, 13F) > a reputable outlet (CNBC, Bloomberg, Reuters, Sifted, ImpactAlpha, Canary Media) > everything else. A single low-quality blog is NOT enough.
- A deal only counts if the SAME source names BOTH (a) this office as the investor and (b) the specific company or fund.
- Separate the company's public round size from the office's actual participation. If the office's stake is not disclosed, you may report the round size but treat the amount as approximate.
- Assign confidence honestly:
  - "Confirmed" = primary source or explicit disclosure.
  - "Reported" = named in a reputable outlet; figures approximate.
  - "Inferred" = you could not verify a specific office->company link to a real source. (These will be quarantined, never published — so do NOT label something Confirmed/Reported without a working source_url.)
- Only count CLIMATE or FRONTIER-TECH deals (energy, carbon, climate, fusion, space, deep-tech, frontier bio/hard-tech). Ignore unrelated holdings.
- Never invent a source_url. If you have no real link, source_url must be null and confidence must be "Inferred".

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"office":"<name>","deals":[{"company":"<name>","amount_usd_m":<number|null>,"confidence":"Confirmed|Reported|Inferred","source_url":"<url|null>","source_name":"<short label|null>","is_fund":<true|false>}],"activity_90d":<integer>,"notes":"<one line>"}`;

function extractJson(text: string): any {
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const ALLOWED: Confidence[] = ["Confirmed", "Reported", "Inferred"];

export async function verifyOffice(name: string, principal: string | null): Promise<OfficeFindings> {
  const user = `Office: ${name}${principal ? ` (principal/family: ${principal})` : ""}

Find this office's verified CLIMATE or FRONTIER-TECH investments, prioritising the last ~90 days but including notable standing positions. Apply the gate. Return the JSON object only.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    // Anthropic-executed server tool: Claude runs the searches and returns a final answer.
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 } as any],
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");

  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    // If the model didn't return parseable JSON, fail safe: nothing verified.
    return { office: name, deals: [], activity_90d: 0, notes: "parse-error: no JSON returned" };
  }

  // Coerce + enforce the gate defensively (don't trust the model to be perfectly disciplined).
  const deals: VerifiedDeal[] = Array.isArray(parsed.deals)
    ? parsed.deals.map((d: any) => {
        let conf: Confidence = ALLOWED.includes(d.confidence) ? d.confidence : "Inferred";
        const url = typeof d.source_url === "string" && /^https?:\/\//i.test(d.source_url) ? d.source_url : null;
        // No real URL => cannot be Confirmed/Reported. Enforce, regardless of what the model said.
        if (!url) conf = "Inferred";
        return {
          company: String(d.company ?? "").trim(),
          amount_usd_m: Number.isFinite(d.amount_usd_m) ? Math.round(d.amount_usd_m) : null,
          confidence: conf,
          source_url: url,
          source_name: typeof d.source_name === "string" ? d.source_name : null,
          is_fund: Boolean(d.is_fund),
        };
      }).filter((d: VerifiedDeal) => d.company)
    : [];

  return {
    office: name,
    deals,
    activity_90d: Number.isFinite(parsed.activity_90d) ? Math.max(0, Math.round(parsed.activity_90d)) : 0,
    notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 200) : "",
  };
}
