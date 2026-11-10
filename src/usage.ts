// What Sprigo's AI calls cost (#48): the feature labels recorded with each call and the monthly roll-up.
// Pure, so node tests can cover the cost estimate without opening a database (src/db.ts runs the SQL).
import { costOf } from "./prices.ts";

export const FEATURES = ["lesson", "check", "guide", "story", "writing", "practice", "tutor", "lookup", "memory", "garden"] as const;
export type AiFeature = (typeof FEATURES)[number];

/** One (month, feature, provider, model) group from ai_usage. Months are local YYYY-MM. */
export type UsageRow = {
  month: string; feature: AiFeature; provider: string; model: string; input_tokens: number; output_tokens: number;
};

export type UsageModel = { provider: string; model: string; input: number; output: number; usd: number | null };
export type UsageFeature = {
  feature: AiFeature; input: number; output: number; usd: number;
  /** At least one model had a known price. */ priced: boolean;
  /** A model had no known price, so `usd` is a lower bound. */ unpriced: boolean;
  models: UsageModel[];
};
export type UsageMonth = {
  input: number; output: number; usd: number; priced: boolean; unpriced: boolean; features: UsageFeature[];
};

/** Runs on the ai_usage table (migration v8); grouped in SQLite so the UI only maps a small result. */
export const USAGE_SQL = `
SELECT strftime('%Y-%m', created_at, 'localtime') AS month, feature, provider, model,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
FROM ai_usage
GROUP BY month, feature, provider, model
ORDER BY month DESC, feature, provider, model`;

/** The local month of `d`, matching the SQL's `localtime` grouping. */
export function monthOf(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** One month's tokens and estimated cost, split by feature (in FEATURES order) with each model underneath. */
export function summarize(rows: UsageRow[], month: string): UsageMonth {
  const out: UsageMonth = { input: 0, output: 0, usd: 0, priced: false, unpriced: false, features: [] };
  const byFeature = new Map<AiFeature, UsageFeature>();
  for (const r of rows.filter((x) => x.month === month)) {
    const usd = costOf(r.provider, r.model, r.input_tokens, r.output_tokens);
    let f = byFeature.get(r.feature);
    if (!f) {
      f = { feature: r.feature, input: 0, output: 0, usd: 0, priced: false, unpriced: false, models: [] };
      byFeature.set(r.feature, f);
    }
    f.input += r.input_tokens;
    f.output += r.output_tokens;
    f.models.push({ provider: r.provider, model: r.model, input: r.input_tokens, output: r.output_tokens, usd });
    out.input += r.input_tokens;
    out.output += r.output_tokens;
    if (usd === null) { f.unpriced = out.unpriced = true; }
    else { f.usd += usd; out.usd += usd; f.priced = out.priced = true; }
  }
  const order = (f: AiFeature) => { const i = FEATURES.indexOf(f); return i < 0 ? FEATURES.length : i; };
  out.features = [...byFeature.values()].sort((a, b) => order(a.feature) - order(b.feature));
  return out;
}
