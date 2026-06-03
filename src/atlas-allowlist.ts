// The Atlas ecosystem allowlist — the canonical list of family offices / institutions Atlas
// actually knows, works with, or has in the WeTheAtlas coalition (the relationship map).
// This is the SINGLE SOURCE OF TRUTH for the `atlas_member` badge.
//
//   • To add an Atlas relationship: add a distinctive token to ATLAS_KEYS.
//   • To remove one: delete its token.
//   • Globally-scouted offices are NOT Atlas unless their name/principal matches a key here.
//
// Matching is normalized-substring against the office name OR principal, so the list format
// need not match the DB name exactly (e.g. "leitmotif" matches "Leitmotif (VW / Porsche-Piech)").

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// One distinctive token per coalition entry (specific enough to avoid false matches).
const ATLAS_KEYS = [
  "gic", "temasek", "blackrock", "breakthrough energy", "gates", "bezos", "emerson collective",
  "powell jobs", "chan zuckerberg", "saverin", "b capital", "jameel", "jimco", "leitmotif",
  "porsche piech", "samsung", "agnelli", "lingotto", "elkann", "cma cgm", "saade", "hunt",
  "hans peter wild", "sabanci", "shopify", "lutke", "thistledown", "skoll", "capricorn",
  "euclidean", "simons estate", "bw group", "sohmen", "dolby", "quandt", "klatten", "bmw",
  "ghaffarian", "paradigm", "ehrsam", "sijbrandij", "tiger global", "chase coleman", "lowercarbon",
  "sacca", "time ventures", "benioff", "kimbal", "scg", "thai crown", "holcim", "maqer", "vale",
  "arcelormittal", "safran", "eni next", "koo family", "honda", "kraft heinz", "evolv", "mitsui",
  "mitsubishi", "starlight", "sosv", "hax", "indiebio", "obvious ventures",
].map(norm);

// Guards: names that would falsely match a key above but are NOT the coalition entity.
// e.g. "Temasek-backed GenZero" contains "temasek" but is a separate fund, not Temasek itself.
const NOT_ATLAS = ["genzero"].map(norm);

export function isAtlasMember(name: string | null, principal: string | null = null): boolean {
  const blob = `${norm(name)} ${norm(principal)}`;
  if (NOT_ATLAS.some((x) => x && blob.includes(x))) return false;
  return ATLAS_KEYS.some((k) => k && blob.includes(k));
}
