// Lesson quality eval (#21): generates fixed step lessons with the app's real prompts (src/activities.ts) on Ollama,
// checks every exercise (src/evalRules.ts) and, with JUDGE set, has a judge model score it. Reports go to eval/ (gitignored).
// pnpm eval [model…]   (default: every model Ollama lists; JUDGE=<model> adds the judge; OLLAMA=<url>, e.g. http://localhost:1234 for LM Studio with named models)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { z } from "zod";
import { REGISTRY, langEn, lessonPrompt, lessonSchema, plannedActivities, systemPrompt, type LessonActivity, type LessonContext } from "../src/activities.ts";
import { retry } from "../src/retry.ts";
import { levelsOf, parseCourse } from "../src/course.ts";
import { checkItem, lessonMetrics, RULES, summarize, type ItemResult, type Judged, type Lang, type TypeRow } from "../src/evalRules.ts";

const BASE = process.env.OLLAMA ?? "http://localhost:11434", JUDGE = process.env.JUDGE;

// Together these cover every type in REGISTRY. Changing the list makes old reports incomparable: note it in the PR.
const CASES: { course: Lang; step: string; native: Lang }[] = [
  { course: "en", step: "basic-greetings", native: "tr" }, // A1: learn, word_select, match, listen_select, speak
  { course: "de", step: "introduce-yourself", native: "tr" }, // A1: translate, fill_blank, word_bank, dialogue
  { course: "es", step: "how-are-you", native: "tr" }, // A1: multiple_choice, word_bank, listen_type, dialogue
  { course: "en", step: "jobs-vocabulary", native: "tr" }, // A2: match, image_select, listen_select
  { course: "en", step: "adverbs-of-frequency", native: "tr" }, // A2: sentence_complete, error_correct, listen_type
  { course: "en", step: "present-perfect-vs-past-simple", native: "tr" }, // B1: fill_blank, error_correct, multiple_choice
  { course: "en", step: "conditional-inversion", native: "tr" }, // C1: fill_blank, word_bank, translate
  { course: "tr", step: "how-old", native: "en" }, // Turkish as the target: word_bank, translate, error_correct
  { course: "hu", step: "likes-dislikes", native: "en" }, // Hungarian as the target: definite conjugation in word_bank, error_correct, translate
];

/** Normal steps only: the part of stepContext (src/lessons.ts, which imports the database) the cases need. */
function contextOf(k: (typeof CASES)[number]): LessonContext {
  const course = parseCourse(readFileSync(new URL(`../courses/${k.course}.yml`, import.meta.url), "utf8"), `${k.course}.yml`);
  for (const level of levelsOf(course)) {
    const levelDef = course.levels[level]!;
    for (const u of levelDef.units) {
      const step = u.steps.find((s) => s.id === k.step);
      if (step) return { course, level, levelDef, unitTitle: u.title, step, native: k.native };
    }
  }
  throw new Error(`eval case ${k.course}/${k.step}: no such step in courses/${k.course}.yml`);
}
const contexts = CASES.map(contextOf); // a renamed step fails here, before any model call

// Same rule as `reasoning` in src/ai.ts.
const effort = (m: string) => (m.startsWith("glm-5.3-flash") ? "low" : "none");

/** Loads a cold model before the first timed call, like warmUp in src/ai.ts. Errors are ignored. */
const warmed = new Set<string>();
async function warm(model: string) {
  if (warmed.has(model)) return;
  warmed.add(model);
  await fetch(`${BASE}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: "10m" }), signal: AbortSignal.timeout(180_000) }).then((r) => r.arrayBuffer()).catch(() => {});
}

// A bad reply is tried again (3 tries in all, like generate in src/ai.ts); HTTP errors and timeouts fail at once.
const badReply = (e: unknown) => e instanceof z.ZodError || e instanceof SyntaxError || (e as Error)?.message === "no JSON object in the reply";

/** One structured call, sent the way src/ai.ts sends it (json_schema response_format, schema in the prompt too). */
const chat = <S extends z.ZodType>(model: string, schema: S, system: string, prompt: string, temperature?: number): Promise<z.infer<S>> =>
  retry(() => chatOnce(model, schema, system, prompt, temperature), badReply);
async function chatOnce<S extends z.ZodType>(model: string, schema: S, system: string, prompt: string, temperature?: number): Promise<z.infer<S>> {
  const json = z.toJSONSchema(schema);
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(180_000), // like generate()
    body: JSON.stringify({ model, reasoning_effort: effort(model), temperature,
      response_format: { type: "json_schema", json_schema: { name: "response", schema: json, strict: true } },
      messages: [{ role: "system", content: `${system}\n\nJSON schema of the reply:\n${JSON.stringify(json)}` }, { role: "user", content: prompt }] }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const text: string = (await r.json()).choices?.[0]?.message?.content ?? "";
  const a = text.indexOf("{"), b = text.lastIndexOf("}"); // like extractJson in src/ai.ts
  if (a < 0 || b < a) throw new Error("no JSON object in the reply");
  return schema.parse(JSON.parse(text.slice(a, b + 1)));
}

type Raw = { key: string; type: string; raw: any };
const take = (a: LessonActivity, list: unknown[] = []): Raw[] => list.map((raw) => ({ key: a.key, type: a.type, raw }));
const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** Like generateItems in src/lessons.ts: one call for the whole step, else one call per activity. */
async function generateLesson(model: string, c: LessonContext) {
  const acts = plannedActivities(c.step.activities), system = systemPrompt(c);
  try {
    const out = await chat(model, lessonSchema(acts), system, lessonPrompt(c, acts)) as Record<string, unknown[]>;
    const raws = acts.flatMap((a) => take(a, out[a.key]));
    if (raws.length) return { acts, fallback: false, raws };
  } catch (e) { console.error(`    whole lesson failed (${short(e).slice(0, 80)}), trying per activity`); }
  const raws: Raw[] = [];
  for (const a of acts) {
    const one = { ...a, key: "items" };
    try {
      const out = await chat(model, z.object({ items: z.array(REGISTRY[a.type]!.schema).min(1).max(a.count) }), system, lessonPrompt(c, [one]));
      raws.push(...take(a, out.items));
    } catch (e) { console.error(`    ${a.type} failed: ${short(e).slice(0, 80)}`); }
  }
  return { acts, fallback: true, raws };
}

const judgeSchema = z.object({
  notes: z.string(), // first, so the model reasons before it scores
  natural: z.int().min(1).max(5), level_fit: z.int().min(1).max(5), clear: z.int().min(1).max(5), one_correct: z.boolean(),
});
const judgeSystem = (c: LessonContext) => [
  `You review exercises written for a language-learning app. The learner is a native ${langEn(c.native)} speaker learning ${c.course.name} at CEFR level ${c.level}.`,
  "Score the one exercise you are given. `notes`: one or two sentences on its problems, written before the scores.",
  "`natural` 1–5: the target-language text sounds like a native speaker wrote it.",
  `\`level_fit\` 1–5: its vocabulary and grammar suit ${c.level}.`,
  "`clear` 1–5: the instruction says unambiguously what to do.",
  "`one_correct`: exactly one option or answer is correct (true for exercises without options).",
  "Respond only with JSON matching the schema.",
].join("\n");
// A failed call stays null (unscored) but is counted and shown, so a flaky judge is visible.
let judgeFails = 0, judgeCalls = 0;
const judgeItem = (c: LessonContext, r: Raw): Promise<Judged> => {
  judgeCalls++;
  return chat(JUDGE!, judgeSchema, judgeSystem(c), `Exercise type: ${r.type}\n${JSON.stringify(r.raw)}`, 0).catch((e) => {
    if (!judgeFails++) console.error(`    judge failed (first error): ${short(e)}`);
    return null;
  });
};

type Case = (typeof CASES)[number] & { level: string } & (
  | { error: string }
  | { fallback: boolean; ms: number; count_ok: boolean; vocab_coverage: number; repeats: number; items: (ItemResult & { key: string })[] });

const git = (args: string) => { try { return execSync(`git ${args}`, { encoding: "utf8" }).trim(); } catch { return ""; } };
const meta = { judge: JUDGE ?? null, date: new Date().toISOString(), commit: git("rev-parse --short HEAD"), dirty: git("status --porcelain") !== "", cases: CASES };

const expected = contexts.reduce((sum, c) => sum + plannedActivities(c.step.activities).reduce((m, a) => m + a.count, 0), 0);
/** What the table is built from; errored cases are in the denominators so a model cannot look better by failing. */
function summaryOf(cases: Case[]) {
  const ok = cases.flatMap((x) => ("error" in x ? [] : [x]));
  const summary = { cases_ok: ok.length, cases: cases.length, fallback: ok.filter((x) => x.fallback).length, count_ok: ok.filter((x) => x.count_ok).length,
    items: ok.reduce((m, x) => m + x.items.length, 0), items_expected: expected, judge_failed: judgeFails, judge_calls: judgeCalls };
  return { ...summary, text: `cases ok ${summary.cases_ok}/${summary.cases} · fallback ${summary.fallback} · count ok ${summary.count_ok}/${summary.cases_ok} · items ${summary.items}/${expected} expected` };
}

function markdown(model: string, rows: TypeRow[], cases: Case[], summary: ReturnType<typeof summaryOf>) {
  const line = (cells: unknown[]) => `| ${cells.map((x) => x ?? "–").join(" | ")} |`;
  const head = ["type", "items", "pass %", ...RULES, ...(JUDGE ? ["natural", "level fit", "clear", "one correct %"] : [])];
  const caseHead = ["case", "level", "ms", "fallback", "count ok", "vocab %", "repeats"];
  return [
    `# Lesson eval: ${model}`, "",
    `${meta.date} · commit ${meta.commit}${meta.dirty ? " (dirty)" : ""} · judge ${JUDGE ? `${JUDGE}${judgeFails ? ` (failed ${judgeFails}/${judgeCalls})` : ""}` : "none"}`, summary.text, "",
    line(head), line(head.map(() => "---")),
    ...rows.map((r) => line([r.type, r.items, r.pass, ...RULES.map((k) => r.fails[k]), ...(JUDGE ? [r.natural, r.level_fit, r.clear, r.one_correct] : [])])),
    "", "## Cases", "", line(caseHead), line(caseHead.map(() => "---")),
    ...cases.map((x) => "error" in x
      ? line([`${x.course}/${x.step}`, x.level, `error: ${x.error.replace(/\|/g, "/").replace(/\s+/g, " ")}`, "", "", "", ""])
      : line([`${x.course}/${x.step}`, x.level, x.ms, x.fallback ? "yes" : "", x.count_ok ? "yes" : "no", x.vocab_coverage, x.repeats])),
    "", "## Failures", "",
    ...cases.flatMap((x) => "error" in x ? [] : x.items.filter((it) => it.failed.length)
      .map((it) => `- **${x.course}/${x.step}** ${it.type} [${it.failed.join(", ")}]: \`${JSON.stringify(it.raw).replace(/\`/g, "'")}\``)),
  ].join("\n") + "\n";
}

const models: string[] = process.argv.slice(2).length ? process.argv.slice(2)
  : (await (await fetch(`${BASE}/api/tags`)).json()).models.map((m: { name: string }) => m.name).filter((n: string) => !/embed|ocr/.test(n));
mkdirSync(new URL("../eval/", import.meta.url), { recursive: true });
const stamp = meta.date.slice(0, 16).replace("T", "-").replace(":", ""); // 2026-10-16-1405 (UTC)

for (const model of models) {
  console.error(`\n${model}${JUDGE ? ` (judge ${JUDGE})` : ""}`);
  const cases: Case[] = [];
  judgeFails = judgeCalls = 0;
  await warm(model);
  if (JUDGE) await warm(JUDGE);
  for (const [i, k] of CASES.entries()) {
    const c = contexts[i], t0 = performance.now();
    try {
      const { acts, fallback, raws } = await generateLesson(model, c);
      const ms = Math.round(performance.now() - t0);
      if (!raws.length) throw new Error("the model returned no usable exercises");
      const items: (ItemResult & { key: string })[] = [];
      for (const r of raws) {
        const failed = checkItem(r.type, r.raw, { target: k.course, native: k.native });
        items.push(JUDGE ? { ...r, failed, judge: await judgeItem(c, r) } : { ...r, failed });
      }
      const count_ok = acts.every((a) => raws.filter((r) => r.key === a.key).length === a.count);
      cases.push({ ...k, level: c.level, fallback, ms, count_ok, ...lessonMetrics(c.step.vocabulary, raws, k.native), items });
      console.error(`  ${k.course}/${k.step}: ${items.filter((it) => !it.failed.length).length}/${items.length} pass, ${ms} ms${fallback ? ", fallback" : ""}`);
    } catch (e) {
      cases.push({ ...k, level: c.level, error: short(e) });
      console.error(`  ${k.course}/${k.step}: ${short(e).slice(0, 80)}`);
    }
  }
  const rows = summarize(cases.flatMap((x) => ("error" in x ? [] : x.items)));
  const summary = summaryOf(cases);
  const file = new URL(`../eval/${stamp}-${model.replace(/[:/]/g, "-")}`, import.meta.url).pathname;
  writeFileSync(`${file}.json`, JSON.stringify({ meta: { ...meta, model, summary }, cases }, null, 2));
  writeFileSync(`${file}.md`, markdown(model, rows, cases, summary));
  console.table(rows.map(({ fails, ...r }) => ({ ...r, ...fails })));
  console.error(summary.text + (JUDGE ? ` · judge failed ${judgeFails}/${judgeCalls}` : ""));
  console.error(`→ ${file}.md`);
}
