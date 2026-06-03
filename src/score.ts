// Shared scoring (proposal §8). Imported by BOTH the API (server.ts) and the churn worker
// (refresh.ts) so the ranking can never diverge between "what the page shows" and "what the
// worker uses to decide the top 100".
//
// Activity is now WEIGHTED (was 0 in Phase 1). This is what makes churn meaningful:
// an office with recent verified deals (high activity_90d) rises; a stale one (no activity
// in 90 days) falls and can drop off the list. The worker writes real activity_90d each run;
// until the first run, seeded activity_90d is a placeholder, so the very first ranking is
// approximate until one refresh has happened.
export const SCORE_WEIGHTS = { activity: 0.40, capital: 0.35, breadth: 0.25 };

export interface ScorableOffice {
  activity90d: number;
  investments: { amountUsdM: number | null }[];
}

export function scoreOffices<T extends ScorableOffice>(offices: T[]) {
  // Capital uses a log scale so one huge figure (e.g. a $10B line) can't dominate the axis
  // and flatten everyone else — the distortion we flagged on Future Ventures / Horizons.
  const cap = offices.map((o) => o.investments.reduce((s, i) => s + (i.amountUsdM ?? 0), 0));
  const capLog = cap.map((c) => Math.log10(1 + c));
  const breadth = offices.map((o) => o.investments.length);
  const activity = offices.map((o) => o.activity90d ?? 0);
  const max = (a: number[]) => Math.max(1, ...a);
  const mc = max(capLog), mb = max(breadth), ma = max(activity);
  const sw = SCORE_WEIGHTS.activity + SCORE_WEIGHTS.capital + SCORE_WEIGHTS.breadth;
  return offices.map((o, i) => ({
    ...o,
    capitalUsdM: cap[i],
    breadth: breadth[i],
    score: Math.round(
      ((SCORE_WEIGHTS.activity * activity[i]) / ma +
        (SCORE_WEIGHTS.capital * capLog[i]) / mc +
        (SCORE_WEIGHTS.breadth * breadth[i]) / mb) / sw * 100
    ),
  }));
}
