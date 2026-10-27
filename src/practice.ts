// Practice together: the exercise panel inside the tutor call. Pure module, tested by src/practice.test.ts.
// The app owns the flow and grades answers; the tutor only gets events and a text picture of the screen (describePractice).
import { z } from "zod";
import { CEFR, levelsOf, type Cefr, type Course, type CourseLevel } from "./course.ts";
import { lessonSchema, normalize, REGISTRY, toItems, type Item, type LessonActivity } from "./activities.ts";
import { currentUnit } from "./tutor.ts";

export const PRACTICE_XP = 5; // per correct answer, added to the call's XP

// ---- Topics: one per finished unit, never above the learner's level ----

export type Unit = CourseLevel["units"][number];
export type Topic = { unit: Unit; level: Cefr };

/** Finished units up to the learner's level; the current unit when none is finished yet. */
export function practiceTopics(course: Course, level: Cefr, done: Set<string>): Topic[] {
  const out: Topic[] = [];
  for (const lv of levelsOf(course)) {
    if (CEFR.indexOf(lv) > CEFR.indexOf(level)) break;
    for (const unit of course.levels[lv]!.units) if (unit.steps.every((s) => done.has(s.id))) out.push({ unit, level: lv });
  }
  const here = course.levels[level];
  return out.length || !here ? out : [{ unit: currentUnit(here, done), level }];
}

/** The topic a spoken reply names: its exact title first, else a sentence containing it. */
export function findTopic(topics: Topic[], said: string) {
  const g = normalize(said);
  return topics.find((t) => normalize(t.unit.title) === g) ?? topics.find((t) => g.includes(normalize(t.unit.title)));
}

// ---- Content: one model call per unit, cached as `practice:<unitId>` ----

const WARMUP: LessonActivity[] = [
  { key: "warmup_blank", type: "fill_blank", count: 2, hints: {} },
  { key: "warmup_choice", type: "multiple_choice", count: 1, hints: {} },
  { key: "warmup_bank", type: "word_bank", count: 1, hints: {} },
];
const COMPREHENSION: LessonActivity[] = [{ key: "comprehension", type: "multiple_choice", count: 2, hints: {} }];

// Field order is the writing order: the questions about the text come after the text.
export const practiceSchema = z.object({
  ...lessonSchema(WARMUP).shape,
  reading_title: z.string(),
  reading_text: z.string(),
  ...lessonSchema(COMPREHENSION).shape,
  discussion: z.array(z.string()).min(1).max(3),
});

export function practicePrompt(unit: string, words: string[], grammar: string[]): string {
  return [
    `Write a practice session for the unit "${unit}". Vocabulary: ${words.join(", ") || "(none)"}. Grammar: ${grammar.join(" | ") || "(none)"}.`,
    "Fields:",
    ...WARMUP.map((a) => `- ${a.key}: ${a.count} × ${a.type}. ${REGISTRY[a.type]!.guide}`),
    "- reading_title, reading_text: a short target-language text (80–120 words) that uses the unit's words and grammar: a small everyday story, message or dialogue.",
    ...COMPREHENSION.map((a) => `- ${a.key}: ${a.count} × multiple_choice about what the reading text says. ${REGISTRY[a.type]!.guide}`),
    `- discussion: 3 open target-language questions linked to the text's topic but about the learner's real life. One asks about their own experience ("Have you ever…?"). No yes/no-only questions.`,
  ].join("\n");
}

export type PracticeSet = { warmup: Item[]; reading: { title: string; text: string }; comprehension: Item[]; discussion: string[] };

/** `langs`: the course and native languages (see toItems). */
export function toPracticeSet(out: Record<string, unknown>, langs: string[]): PracticeSet {
  const lists = out as Record<string, unknown[]>;
  return {
    warmup: toItems(WARMUP, lists, langs),
    reading: { title: String(out.reading_title ?? ""), text: String(out.reading_text ?? "") },
    comprehension: toItems(COMPREHENSION, lists, langs),
    discussion: ((out.discussion as string[] | undefined) ?? []).map((q) => q.trim()).filter(Boolean),
  };
}

// ---- Flow ----

export const STAGES = ["topics", "warmup", "reading", "comprehension", "discussion", "done"] as const;
export type Stage = (typeof STAGES)[number];
export type Answered = { correct: boolean; given: string; expected: string };
export type PracticeState = { stage: Stage; set: PracticeSet | null; i: number; score: number; total: number; last: Answered | null };

export const openPractice = (): PracticeState => ({ stage: "topics", set: null, i: 0, score: 0, total: 0, last: null });

const size = (set: PracticeSet | null, stage: Stage) =>
  !set ? 0 : stage === "warmup" ? set.warmup.length : stage === "reading" ? 1
    : stage === "comprehension" ? set.comprehension.length : stage === "discussion" ? set.discussion.length : 0;

/** The first stage from index `from` on that has something in it. */
function enter(st: PracticeState, from: number): PracticeState {
  for (let k = from; k < STAGES.length - 1; k++) if (size(st.set, STAGES[k]) > 0) return { ...st, stage: STAGES[k], i: 0, last: null };
  return { ...st, stage: "done", i: 0, last: null };
}

export const begin = (st: PracticeState, set: PracticeSet) => enter({ ...st, set }, STAGES.indexOf("warmup"));

export function next(st: PracticeState): PracticeState {
  if (st.stage === "topics" || st.stage === "done") return st;
  return st.i + 1 < size(st.set, st.stage) ? { ...st, i: st.i + 1, last: null } : enter(st, STAGES.indexOf(st.stage) + 1);
}

/** The exercise on screen; only the warm-up and reading-question stages have one. */
export function currentItem(st: PracticeState): Item | null {
  if (st.stage === "warmup") return st.set?.warmup[st.i] ?? null;
  if (st.stage === "comprehension") return st.set?.comprehension[st.i] ?? null;
  return null;
}

export const expected = (it: Item) => (it.kind === "choice" ? it.options[it.answer] : it.kind === "bank" ? it.answer.join(" ") : "");

/** Which option an answer means: its text, else its number as shown on screen ("2"). -1 for none. */
function optionIndex(it: Extract<Item, { kind: "choice" }>, given: string) {
  const g = normalize(given), n = Number(g), k = it.options.findIndex((o) => normalize(o) === g);
  if (k >= 0 || !g) return k; // text first: in a numbers unit a clicked "3" may be option 1
  return Number.isInteger(n) && n >= 1 && n <= it.options.length ? n - 1 : -1;
}

/** Whether the app can grade this answer: one of a choice's options, or any sentence for word tiles. */
export const accepts = (it: Item, given: string) => (it.kind === "choice" ? optionIndex(it, given) >= 0 : it.kind === "bank" && !!normalize(given));

/** Word tiles in an order other than the expected one: the AI decides whether it is right too (DECISIONS C4). */
export const needsJudge = (it: Item, given: string) => it.kind === "bank" && accepts(it, given) && normalize(given) !== normalize(expected(it));

/** Grades the item on screen once; answers that are not gradable, or come after the first, change nothing. `judged`: the AI's verdict (needsJudge). */
export function answer(st: PracticeState, given: string, judged?: boolean): PracticeState {
  const it = currentItem(st);
  if (!it || st.last || !accepts(it, given)) return st;
  const k = it.kind === "choice" ? optionIndex(it, given) : -1;
  const correct = it.kind === "choice" ? k === it.answer : judged ?? normalize(given) === normalize(expected(it));
  const last = { correct, given: it.kind === "choice" ? it.options[k] : given.trim(), expected: expected(it) };
  return { ...st, score: st.score + (correct ? 1 : 0), total: st.total + 1, last };
}

// ---- What the tutor is told about the screen ----

const itemText = (it: Item) =>
  it.kind === "choice" ? `${it.prompt}${it.context ? ` ${it.context}` : ""} Options: ${it.options.map((o, k) => `${k + 1}) ${o}`).join("  ")}`
    : it.kind === "bank" ? `${it.prompt} Word tiles: ${it.bank.join(" / ")}` : "";

export function describePractice(st: PracticeState | null, topics: Topic[]): string {
  const list = topics.map((t) => t.unit.title).join(", ");
  if (!st) return `The practice panel is closed. Topics the learner could practise: ${list}.`;
  const set = st.set;
  if (st.stage === "topics" || !set) return `The practice panel is open and lists these topics: ${list}. Ask which one to practise. When the learner names one, put its exact title in \`answer\`.`;
  if (st.stage === "warmup" || st.stage === "comprehension") {
    const it = currentItem(st)!, n = st.stage === "warmup" ? set.warmup.length : set.comprehension.length;
    return [
      `Stage: ${st.stage === "warmup" ? "warm-up" : "questions about the reading"}, exercise ${st.i + 1} of ${n}.`,
      st.stage === "comprehension" ? `The reading text: ${set.reading.text}` : "",
      `On screen: ${itemText(it)}`,
      `Correct answer (never say it before the learner answers): ${expected(it)}`,
      st.last ? `The learner answered "${st.last.given}": ${st.last.correct ? "correct" : "wrong"}.`
        : "The learner has not answered yet. If they give an answer aloud or in the chat (\"I think it's like\", \"number 2\"), copy it into `answer` (the option's text or number, or the whole sentence for word tiles) and leave `say` empty: the app checks it and tells you the result. Never ask them to tap the screen instead.",
    ].filter(Boolean).join("\n");
  }
  if (st.stage === "reading") return `Stage: reading. On screen, the text "${set.reading.title}": ${set.reading.text}\nWhen the learner is ready for the questions, set \`answer\` to "next" and do not ask a question yet: the app shows it and asks you to introduce it.`;
  if (st.stage === "discussion") {
    const q = set.discussion, lastQ = st.i === q.length - 1;
    return [
      // Only the current question: shown the rest, the model asks the next one before the app moves on, then again after.
      `Stage: discussion, question ${st.i + 1} of ${q.length}: "${q[st.i]}".`,
      `They build on the reading text: ${set.reading.text}`,
      lastQ ? "This is the last question: ask the learner to ask you this question, then answer it from your own experience."
        : "Ask it, react to the learner's answer, share a short story of your own (up to 3 sentences) and ask at most one follow-up.",
      `When this question has been talked through, set \`answer\` to "next" and only close it (e.g. "Nice story!"): the app then shows the next question and asks you to introduce it.`,
    ].join("\n");
  }
  return "The practice is finished.";
}
