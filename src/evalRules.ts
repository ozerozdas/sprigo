// Rule checks for `pnpm eval` (#21): what a generated exercise must get right beyond its JSON shape.
// Pure module (no Vite/Tauri imports), tested by src/evalRules.test.ts.
import { givesAway, normalize, REGISTRY, strayScript } from "./activities.ts";

export const LANGS = ["en", "de", "es", "fr", "tr", "hu", "pl"] as const;
export type Lang = (typeof LANGS)[number];
export const RULES = ["answer_in_options", "distinct_options", "no_leak", "target_lang", "native_lang", "one_blank", "dropped"] as const;
export type Rule = (typeof RULES)[number];
export type Judged = { notes: string; natural: number; level_fit: number; clear: number; one_correct: boolean } | null;
export type ItemResult = { type: string; raw: any; failed: Rule[]; judge?: Judged };

// normalize uses toLocaleLowerCase, which turns "I" into "ı" under a Turkish locale.
const n = (t: string) => normalize(t.toLowerCase());

// ponytail: stopword guess; a language-detection library if it misfires.
const STOP: Record<Lang, Set<string>> = {
  en: new Set("the a an is are was were i you he she it we they to of and in on at for with my your this that do does not have has".split(" ")),
  de: new Set("der die das ein eine ist sind ich du er sie es wir ihr und nicht zu mit von den dem bin hast hat auf für".split(" ")),
  es: new Set("el la los las un una es son yo tú él ella y no de en con por para que mi tu soy estoy está muy del lo más qué cómo dónde cuándo también aquí sí hay pero como este esta esto eso tiene tengo voy vas hace".split(" ")),
  fr: new Set("le la les un une est sont je tu il elle nous vous et ne pas de en avec pour que mon ton suis c'est très".split(" ")),
  tr: new Set("bir ve bu şu ben sen o biz siz onlar değil mi mı mu mü ne çok için ile da de var yok".split(" ")),
  hu: new Set("a az egy és nem van vannak vagyok vagy vagyunk volt voltam lesz hogy ez ezt azt én ő ők meg már még csak itt ott igen nagyon nincs mert sok jó kell lehet mint sem fel tegnap holnap nekem neked neki ha amikor aki ami amit ahol hol kérem köszönöm minden ezért azért nap jól úr".split(" ")),
  pl: new Set("w z na nie się jest że jak co ale tak czy ten ta jestem mam masz bardzo dla od po przez który która które jeśli bo już też tylko kiedy gdzie dlaczego zdanie słowo".split(" ")),
};
// Letters only one of these languages uses (ö and ü are shared by German, Turkish and Hungarian, ç by French and Turkish,
// á, í, ó and ú by Spanish, Hungarian and Polish); Hungarian's sz, zs, gy and cs are letters of its alphabet, and sz is a
// Polish one too, so it counts for both and their own letters and stopwords decide.
const MARK: Record<Lang, RegExp> = { en: /(?!)/, de: /[ßä]/, es: /ñ/, fr: /[èêœàâùû]/, tr: /[ışğ]/, hu: /[őű]|sz|zs|gy|cs/, pl: /[ąćęłńśźż]|cz|sz/ };

/** The likeliest of LANGS (the course languages and Polish), or null for under 3 words or no clear winner. */
export function guessLang(text: string): Lang | null {
  const words = n(text).split(" ").filter(Boolean);
  if (words.length < 3) return null;
  const ranked = LANGS.map((l) => [l, words.filter((w) => STOP[l].has(w) || MARK[l].test(w)).length] as const).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}

/** The language a typed answer is in (#26: which language dictation listens for). Translations go either way:
 *  native when the answer reads native or the source reads target; otherwise, and for listen_type, the target. */
export function answerLang(it: { answer: string; context: string }, target: string, native: string): string {
  return guessLang(it.answer) === native || guessLang(it.context) === target ? native : target;
}

const CHOICE = new Set(["word_select", "multiple_choice", "image_select", "listen_select", "fill_blank", "sentence_complete", "error_correct"]);

/** Texts that must be in the course language and in the native language. Options are joined: one word alone is too short to guess. */
export function fieldsOf(type: string, g: any, native: Lang): { target: string[]; native: string[] } {
  const opts = g.options?.join(" ") ?? "";
  switch (type) {
    case "learn": return { target: [g.phrase], native: [g.translation, g.note] };
    case "speak": return { target: [g.sentence], native: [g.translation] };
    case "word_select": case "multiple_choice": return { target: [], native: [g.prompt] }; // direction goes either way
    case "image_select": return { target: [opts], native: [g.prompt] };
    case "listen_select": return { target: [g.audio_text], native: [g.prompt] }; // options may be meanings
    case "fill_blank": return { target: [g.sentence_with_blank, opts], native: [g.prompt] };
    case "sentence_complete": return { target: [g.sentence_start, opts], native: [g.prompt] };
    case "error_correct": return { target: [g.wrong_sentence, opts], native: [g.prompt] };
    case "dialogue": return { target: [...g.dialogue_lines, opts], native: [g.prompt] };
    case "word_bank": return { target: [g.answer_words.join(" ")], native: [g.prompt] };
    case "translate": return { target: [guessLang(g.answer) === native ? g.source_sentence : g.answer], native: [g.prompt] };
    case "listen_type": return { target: [g.audio_text], native: [g.prompt] };
    case "match": return { target: [g.pairs.map((p: any) => p.target).join(" ")], native: [g.pairs.map((p: any) => p.native).join(" ")] };
    default: return { target: [], native: [] };
  }
}

const has = (text: string, part: string) => !!n(part) && ` ${n(text)} `.includes(` ${n(part)} `);
/** The item's target-language strings: quoted in a native prompt, they must not decide its language. */
const targetStrings = (g: any): string[] => [g.options, g.dialogue_lines, g.answer_words?.join(" "), g.pairs?.map((p: any) => p.target),
  g.audio_text, g.source_sentence, g.answer, g.phrase, g.sentence, g.sentence_with_blank, g.sentence_start, g.wrong_sentence]
  .flat().filter((s): s is string => typeof s === "string").map(n).filter((s) => s.length >= 3); // shorter ones would eat letters of native words
// Quoted spans start after a space, so Turkish suffixes (İstanbul'a) are not cut. The quoted text may be a meaning the options translate.
const withoutTarget = (text: string, g: any) => targetStrings(g).reduce((t, s) => t.split(s).join(" "), n(text)).replace(/(^| )'[^']*'(?= |$)/g, " ");
const wrongLang = (texts: string[], want: Lang) => texts.some((t) => { const l = guessLang(t); return l !== null && l !== want; });

/** The rules a schema-valid raw item fails, in RULES order. */
export function checkItem(type: string, g: any, ctx: { target: Lang; native: Lang }): Rule[] {
  const bad = new Set<Rule>();
  if (REGISTRY[type]!.toItem(g) === null || strayScript([ctx.target, ctx.native])(g)) bad.add("dropped");
  if (Array.isArray(g.options)) {
    const ok = Number.isInteger(g.answer_index) && g.answer_index >= 0 && g.answer_index < g.options.length;
    if (!ok) bad.add("answer_in_options");
    if (new Set(g.options.map(n)).size !== g.options.length) bad.add("distinct_options");
    if (ok && CHOICE.has(type) && givesAway(g.prompt, g.options, g.answer_index)) bad.add("no_leak");
  }
  if (type === "word_bank") {
    const answer = new Set(g.answer_words.map(n));
    if (g.distractor_words.some((w: string) => answer.has(n(w)))) bad.add("distinct_options");
    if (has(g.prompt, g.answer_words.join(" "))) bad.add("no_leak");
  }
  if (type === "match") {
    const t = g.pairs.map((p: any) => n(p.target)), v = g.pairs.map((p: any) => n(p.native));
    if (new Set(t).size !== t.length || new Set(v).size !== v.length) bad.add("distinct_options");
  }
  if (type === "translate" && n(g.answer) === n(g.source_sentence)) bad.add("no_leak");
  if (type === "listen_type" && has(g.prompt, g.audio_text)) bad.add("no_leak");
  if (type === "fill_blank" && (g.sentence_with_blank.match(/_{3,}/g) ?? []).length !== 1) bad.add("one_blank");
  const f = fieldsOf(type, g, ctx.native);
  if (wrongLang(f.target, ctx.target)) bad.add("target_lang");
  if (wrongLang(f.native.map((t) => withoutTarget(t, g)), ctx.native)) bad.add("native_lang");
  return RULES.filter((r) => bad.has(r));
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** vocab_coverage: % of the step's vocabulary found at a word start in any string of the lesson; repeats: target sentences (3+ words) used by more than one item. */
export function lessonMetrics(vocab: string[], items: { type: string; raw: any }[], native: Lang) {
  const strings = (v: unknown): string[] => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
  const all = ` ${n(items.flatMap((it) => strings(it.raw)).join(" "))}`;
  const words = vocab.filter((v) => n(v)); // an entry that normalizes to nothing would match everywhere
  const seen = new Map<string, number>();
  for (const it of items) {
    const own = new Set(fieldsOf(it.type, it.raw, native).target.map(n).filter((t) => t.split(" ").length >= 3));
    for (const t of own) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  return { vocab_coverage: pct(words.filter((v) => all.includes(` ${n(v)}`)).length, words.length), repeats: [...seen.values()].filter((k) => k > 1).length };
}

export type TypeRow = { type: string; items: number; pass: number; fails: Record<Rule, number>;
  natural: number | null; level_fit: number | null; clear: number | null; one_correct: number | null };

/** One row per activity type (sorted), then a "total" row. `pass` and `one_correct` are %, judge scores are 1-decimal averages. */
export function summarize(items: ItemResult[]): TypeRow[] {
  const row = (type: string, xs: ItemResult[]): TypeRow => {
    const j = xs.flatMap((x) => (x.judge ? [x.judge] : []));
    const avg = (f: (v: NonNullable<Judged>) => number) => (j.length ? Math.round((j.reduce((s, v) => s + f(v), 0) / j.length) * 10) / 10 : null);
    return {
      type, items: xs.length, pass: pct(xs.filter((x) => !x.failed.length).length, xs.length),
      fails: Object.fromEntries(RULES.map((r) => [r, xs.filter((x) => x.failed.includes(r)).length])) as Record<Rule, number>,
      natural: avg((v) => v.natural), level_fit: avg((v) => v.level_fit), clear: avg((v) => v.clear),
      one_correct: j.length ? pct(j.filter((v) => v.one_correct).length, j.length) : null,
    };
  };
  const types = [...new Set(items.map((x) => x.type))].sort();
  return [...types.map((t) => row(t, items.filter((x) => x.type === t))), row("total", items)];
}
