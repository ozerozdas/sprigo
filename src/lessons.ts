// Lesson generation (DECISIONS C2, C3): cache → one call for the whole step → per-activity fallback.
import { crossChecked, formsPrompt, formsSchema, fromTable, pickAsks } from "./conjugation";
import { z } from "zod";
import { generate, generatePlain, generateStream } from "./ai";
import { applyMemoryOps, cachedGuides, enrollmentProfile, getCached, listMemories, listMistakes, markMemoriesUsed, memoryOn, putCached } from "./db";
import { REGISTRY, givesAway, langEn, lessonPrompt, mistakeLine, lessonSchema, plannedActivities, checkPrompt, checkSchema, rejected, reviewSystem, shuffleAnswer, solvePrompt, solveSchema, solveSystem, systemPrompt, toItems, type Item, type LessonContext } from "./activities";
import { CHARACTERS, CHAT_MAX_TURNS, CHAT_MIN_TURNS, FREE_GOAL, type CharacterId } from "./characters";
import { CEFR, levelsOf, storyId, type Course, type CourseLevel, type Cefr } from "./course";
import { looseTutor, tutorPrompt, tutorSchema, tutorSystem, type TutorEvent, type TutorMsg } from "./tutor";
import { cleanOps, looseMemory, memoryPrompt, memorySchema, memorySystem, pickMemories, type MemorySource } from "./memory";
import { practicePrompt, practiceSchema, toPracticeSet, type PracticeSet } from "./practice";
import { cleanDebrief, debriefPrompt, debriefSchema, debriefSystem, looseDebrief, looseRoleTurn, rehearsalSystem, roleTurnSchema, type RehearsalBrief } from "./rehearsal";
import { avoidancePrompt, avoidanceSchema, looseAvoidance } from "./drills";
import { fromGuides, lookupSchema, wordKey, type Lookup } from "./lookup";
import { feedbackPrompt, feedbackSchema, looseFeedback, taskPrompt, taskSchema, writeId, type WritingTask } from "./writing";
import { cleanNote, noteFor, noteFresh, notePrompt, noteSystem, NOTE_KEY, type GardenNote, type NoteInfo } from "./gardenNote";

/** `A1:checkpoint` (path node) and `A1:test` (skip-level test) share one flow (DECISIONS B8). */
export const examLevel = (id: string) => /^([ABC][12]):(checkpoint|test)$/.exec(id)?.[1] as Cefr | undefined;

/** `legend:<step>`: a finished step replayed without teaching cards, written one CEFR level harder (PLAN §3.3). */
export const legendStep = (id: string) => id.startsWith("legend:") ? id.slice(7) : undefined;
export const LEGEND_PASS = 80; // % needed to turn the step gold
export const LEGEND_PRICE = 100; // gems per attempt, or one shop ticket

/** `unit-test:<unit>`: a test over one unit; passing it marks the unit's lessons done, like the level test does for a level. */
export const unitTestOf = (id: string) => id.startsWith("unit-test:") ? id.slice(10) : undefined;
export const UNIT_TEST_PASS = 80;
const UNIT_TEST: CourseLevel["units"][number]["steps"][number]["activities"] = [ // ponytail: one mix for every unit; per-unit YAML tests if a course needs them
  { type: "multiple_choice", count: 3 }, { type: "fill_blank", count: 2 }, { type: "word_bank", count: 2 }, { type: "translate", count: 2 }, { type: "listen_select", count: 1 },
];

/** `grammar:<pattern>` (#29): a short drill on one grammar pattern, set in the first unit that teaches it. Earns XP, marks nothing done. */
export const grammarDrill = (id: string) => id.startsWith("grammar:") ? id.slice(8) : undefined;
const GRAMMAR_DRILL: typeof UNIT_TEST = [{ type: "multiple_choice", count: 2 }, { type: "fill_blank", count: 2 }, { type: "word_bank", count: 2 }];

/** Finds a step and its surroundings in the course tree; exams get a synthetic step covering the whole level. */
export function stepContext(course: Course, stepId: string, native: string): LessonContext | null {
  const legend = legendStep(stepId);
  if (legend) {
    const c = stepContext(course, legend, native);
    if (!c) return null;
    const acts = c.step.activities.filter((a) => a.type !== "learn");
    return {
      ...c, level: CEFR[Math.min(CEFR.indexOf(c.level) + 1, CEFR.length - 1)], // ponytail: C2 stays C2
      step: { ...c.step, id: stepId, activities: acts.length ? acts : c.step.activities,
        description: `${c.step.description ?? ""} Mastery challenge: harder sentences and less obvious distractors than a normal lesson.`.trim() },
    };
  }
  const exam = examLevel(stepId);
  if (exam) {
    const levelDef = course.levels[exam];
    if (!levelDef?.checkpoint) return null;
    const steps = levelDef.units.flatMap((u) => u.steps);
    return {
      course, level: exam, levelDef, unitTitle: levelDef.title, native,
      step: {
        id: stepId, title: levelDef.checkpoint.title,
        description: `Level test covering all of ${exam}: mix topics from every unit, do not focus on one.`,
        vocabulary: [...new Set(steps.flatMap((s) => s.vocabulary))],
        grammar: [...new Map(steps.flatMap((s) => s.grammar).map((g) => [g.pattern, g])).values()],
        activities: levelDef.checkpoint.activities,
      },
    };
  }
  const ut = unitTestOf(stepId), drill = grammarDrill(stepId);
  for (const level of levelsOf(course)) {
    const levelDef = course.levels[level]!;
    for (const u of levelDef.units) {
      const g = drill === undefined ? undefined : u.steps.flatMap((s) => s.grammar).find((g) => g.pattern === drill);
      if (g) return {
        course, level, levelDef, unitTitle: u.title, native,
        step: {
          id: stepId, title: g.pattern,
          description: `Grammar drill on one pattern: every exercise practises "${g.pattern}"; keep the vocabulary simple and from this unit.`,
          vocabulary: unitWords(u), grammar: [g], activities: GRAMMAR_DRILL,
        },
      };
      if (ut === u.id) return {
        course, level, levelDef, unitTitle: u.title, native,
        step: {
          id: stepId, title: u.title,
          description: `Unit test covering all of this unit: mix every lesson's words and grammar, do not focus on one.`,
          vocabulary: [...new Set(u.steps.flatMap((s) => s.vocabulary))],
          grammar: [...new Map(u.steps.flatMap((s) => s.grammar).map((g) => [g.pattern, g])).values()],
          activities: UNIT_TEST,
        },
      };
      const step = u.steps.find((s) => s.id === stepId);
      if (step) return { course, level, levelDef, unitTitle: u.title, step, native };
    }
  }
  return null;
}

export const MISTAKES_IN_PROMPT = 8; // ponytail: most recent only, rank by frequency if prompts need sharper focus

async function generateItems(c: LessonContext, mistakes: string[], about: string[]): Promise<Item[]> {
  const acts = plannedActivities(c.step.activities);
  if (!acts.length) throw new Error("This step has no activities that can be generated yet.");
  const system = systemPrompt(c), langs = [c.course.iso, c.native];
  try {
    const items = toItems(acts, await generate(lessonSchema(acts), system, lessonPrompt(c, acts, mistakes, about)) as Record<string, unknown[]>, langs);
    if (items.length) return reviewed(c, items);
  } catch (e) { console.warn("Whole-lesson generation failed, falling back to per-activity calls", e); }
  // Fallback for small local models that struggle with the full schema.
  const items: Item[] = [];
  let lastError: unknown;
  for (const a of acts) {
    try {
      const out = await generate(z.object({ items: z.array(REGISTRY[a.type]!.schema).min(1).max(a.count) }), system, lessonPrompt(c, [{ ...a, key: "items" }], mistakes, about));
      items.push(...toItems([{ ...a, key: "items" }], out as Record<string, unknown[]>, langs));
    } catch (e) { lastError = e; }
  }
  if (!items.length) throw lastError ?? new Error("The model returned no usable exercises.");
  return reviewed(c, items);
}

// Gemma takes 5–10 s; in tests about 1 request in 60 hung for 5 minutes, which must not hold a lesson back.
const SECOND_LOOK_S = 30;

/** Indexes of the exercises a second look calls wrong (both checks run at once); a check that fails flags nothing. */
async function flagged(c: Parameters<typeof checkPrompt>[0], items: Item[], text = ""): Promise<Set<number>> {
  const quiet = <T>(p: Promise<T>) => p.catch((e) => { console.warn("Second look failed, keeping the exercises as written", e); return null; });
  const solve = solvePrompt(c, items, text);
  const [checked, solved] = await Promise.all([
    quiet(generate(checkSchema, reviewSystem, checkPrompt(c, items, text), undefined, undefined, SECOND_LOOK_S)),
    solve ? quiet(generate(solveSchema, solveSystem(c.course.name), solve, undefined, undefined, SECOND_LOOK_S)) : null,
  ]);
  return rejected(items, checked, solved);
}

/** The lesson without the exercises a second look calls wrong, unless that would leave nothing. */
async function reviewed(c: LessonContext, items: Item[]): Promise<Item[]> {
  const bad = await flagged(c, items), kept = items.filter((_, i) => !bad.has(i));
  return kept.length ? kept : items;
}

const inflight = new Map<string, Promise<Item[]>>();
/** Cached lesson for (enrollment, step); `fresh` regenerates it ("Yeniden üret"). */
export function loadLesson(enrollmentId: number, c: LessonContext, fresh = false): Promise<Item[]> {
  const k = `${enrollmentId}:${c.step.id}`;
  if (!fresh && inflight.has(k)) return inflight.get(k)!;
  const p = (async () => {
    const cached = fresh ? null : await getCached<Item[]>(enrollmentId, c.step.id);
    if (cached) return cached.filter((it) => it.kind !== "choice" || !givesAway(it.prompt, it.options, it.answer)); // cached before the check
    const mistakes = (await listMistakes<Item>(enrollmentId, MISTAKES_IN_PROMPT)).map((m) => mistakeLine(m.item)).filter((x): x is string => !!x);
    const pid = await enrollmentProfile(enrollmentId);
    const items = await generateItems(c, mistakes, pid === null ? [] : await learnerFacts(pid));
    await putCached(enrollmentId, c.step.id, items);
    return items;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/** Background prefetch of the step after `stepId` in the same level (C3). Errors are ignored. */
export function prefetchNext(enrollmentId: number, course: Course, level: Cefr, stepId: string, native: string) {
  const steps = course.levels[level]!.units.flatMap((u) => u.steps);
  const next = steps[steps.findIndex((s) => s.id === stepId) + 1];
  const c = next && stepContext(course, next.id, native);
  if (c) loadLesson(enrollmentId, c).catch(() => {});
}

// ---- Answer judging (C4) and explanations (C5) ----

export async function judge(c: Base, question: string, expected: string, given: string) {
  // ponytail: one retry covers the occasional malformed JSON; the caller reports a second failure
  const run = () => generate(
    z.object({ feedback: z.string(), correct: z.boolean() }), // feedback first: the model reasons before it decides
    systemPrompt(c),
    `Exercise: ${question}\nExpected answer: ${expected}\nLearner's answer: ${given}\n` +
      "Mark it correct if it conveys the same meaning and is grammatical — other wording, word order, synonyms or contractions are fine; " +
      "the expected answer is only one example. British and American usage are both correct. " +
      "Capitalization and punctuation (including a missing final period) never make an answer wrong; accept a single-letter typo but mention it. " +
      "`feedback`: one short sentence.",
  );
  return run().catch(run);
}

/** F: the learner disputes a `judge()` verdict; a second look that is fair but not a pushover. */
export async function appeal(c: LessonContext, question: string, expected: string, given: string, reason: string) {
  const run = () => generate(
    z.object({ reason: z.string(), accepted: z.boolean() }), // reason first, like judge: the model reasons before it decides
    systemPrompt(c),
    `Exercise: ${question}\nExpected answer: ${expected}\nLearner's answer: ${given}\nThe answer was marked wrong. The learner appeals: ${reason}\n` +
      "Be fair but not a pushover: accept only if the learner's answer is genuinely correct or acceptable for this exercise " +
      "(same meaning, grammatical, natural); reject if it is wrong, off-topic, or the argument is merely persuasive. " +
      `\`reason\`: one sentence in ${langEn(c.native)} explaining the decision.`,
  );
  return run().catch(run);
}

export function explain(c: LessonContext, question: string, correct: string, given: string) {
  return generatePlain(systemPrompt(c).replace("Respond only with JSON matching the schema.", ""),
    `Exercise: ${question}\nCorrect answer: ${correct}\nLearner answered: ${given || "(skipped)"}\nExplain in at most 3 short sentences why the correct answer is right${given ? " and what was wrong with the learner's answer" : ""}. Plain text, no markdown.`);
}

// ---- Stories (one per unit) and roleplay chat (Faz 4) ----

export type Base = Pick<LessonContext, "course" | "level" | "native">;
type Unit = CourseLevel["units"][number];

const storySchema = z.object({
  title: z.string(),
  lines: z.array(z.object({ speaker: z.string(), text: z.string(), translation: z.string() })).min(6).max(14),
  questions: z.array(z.object({ after_line: z.int(), prompt: z.string(), options: z.array(z.string()).min(3).max(4), answer: z.int() })).min(1).max(3),
});
export type Story = z.infer<typeof storySchema>;

/** Cached per (enrollment, unit) like lessons; `fresh` regenerates. */
export async function loadStory(enrollmentId: number, c: Base, unit: Unit, fresh = false): Promise<Story> {
  const key = storyId(c.level, unit.id);
  const cached = fresh ? null : await getCached<Story>(enrollmentId, key);
  if (cached) return cached;
  const steps = unit.steps;
  const g = await generate(storySchema, systemPrompt(c), [
    `Write a short story told as a dialogue between 2–3 named characters, on the theme of the unit "${unit.title}"${unit.description ? ` (${unit.description})` : ""}.`,
    `Use vocabulary from: ${[...new Set(steps.flatMap((s) => s.vocabulary))].join(", ")}`,
    `Grammar: ${[...new Set(steps.flatMap((s) => s.grammar.map((x) => x.pattern)))].join(" | ")}`,
    "`title` and every line's `text` are in the target language; `translation` is the line in the learner's language. 8–12 lines with a small plot.",
    "`questions`: 2–3 comprehension questions (prompt in the learner's language, options in the target language), exactly one correct, `answer` is its 0-based index. " +
      "`after_line` is the 0-based index of the line after which it is asked; the question must be answerable from the lines up to there.",
  ].join("\n"));
  const last = g.lines.length - 1;
  const story: Story = {
    ...g,
    questions: g.questions.filter((q) => q.options[q.answer] !== undefined)
      .map((q) => ({ ...q, after_line: Math.min(Math.max(q.after_line, 0), last), ...shuffleAnswer(q.options, q.answer) })),
  };
  await putCached(enrollmentId, key, story);
  return story;
}

/** Writing practice (#25): one task per (enrollment, level, unit), cached like stories; `fresh` regenerates. */
export async function loadWritingTask(enrollmentId: number, c: Base, unit: Unit, fresh = false): Promise<WritingTask> {
  const key = writeId(c.level, unit.id);
  const cached = fresh ? null : await getCached<WritingTask>(enrollmentId, key);
  if (cached) return cached;
  const task = await generate(taskSchema, systemPrompt(c),
    taskPrompt(unit.title, unit.description ?? "", [...new Set(unit.steps.flatMap((s) => s.vocabulary))]));
  await putCached(enrollmentId, key, task);
  return task;
}
/** Conjugation drill (#30): the same forms asked twice, blind; only the ones both answers agree on are kept. Never cached.
 *  A language with bundled tables is asked from them, without the AI. */
export async function loadConjugation(c: Base, prompt: string): Promise<Item[]> {
  const asks = pickAsks(c.course.iso, c.level);
  const bundled = fromTable(c.course.iso, asks, prompt);
  if (bundled) return bundled;
  const ask = (xs: typeof asks) => generate(formsSchema(xs.length), systemPrompt(c), formsPrompt(c.course.name, xs)).then((r) => r.forms);
  // The second answer gets the list reversed: a different prompt, so a deterministic model isn't simply asked twice.
  const [a, b] = await Promise.all([ask(asks), ask([...asks].reverse()).then((f) => f.reverse())]);
  const items = crossChecked(asks, a, b, prompt);
  if (!items.length) throw new Error("The AI's verb forms didn't agree. Try again.");
  return items;
}
export const checkWriting = (c: Base, task: string, text: string) =>
  generate(feedbackSchema, systemPrompt(c), feedbackPrompt(task, text), undefined, looseFeedback);

export type ChatMsg = { from: "ai" | "me"; text: string; translation?: string; correction?: string };

const turnSchema = z.object({ correction: z.string(), reply: z.string(), translation: z.string(), goal_reached: z.boolean() });
// Some models (glm on Ollama) drop goal_reached or correction every time, so retrying can't help; a missing one means "no".
const looseTurn = turnSchema.extend({ correction: z.string().catch(""), goal_reached: z.boolean().catch(false) });

/** The character's next turn; also corrects the learner's last message. Empty history = opening line.
 *  `opts.rules` add lines to the system prompt (drills); `opts.keep` caps how many past messages the prompt carries. */
export function chatTurn(c: Base & { about?: string[] }, who: CharacterId, topic: { goal: string }, history: ChatMsg[], opts: { rules?: string[]; keep?: number } = {}) {
  const ch = CHARACTERS[who], native = langEn(c.native);
  const free = topic.goal.startsWith(FREE_GOAL);
  const sent = history.filter((m) => m.from === "me").length;
  const system = [
    `You are ${ch.name} in a roleplay inside a language-learning app. The learner is a native ${native} speaker learning ${c.course.name} at CEFR level ${c.level}.`,
    free
      // A free topic is the learner's own; the job in the persona must not pull it back into a work scene (a landlord asking about rent in a football chat).
      ? `Your personality: ${ch.persona} The learner picked the topic, so this is a casual chat between two people, not a scene from your job. Keep your personality and manner, but never bring up your work, customers, place or tasks unless the learner does. Topic: ${topic.goal.slice(FREE_GOAL.length)}.`
      : `${ch.persona} The learner's goal: ${topic.goal}.`,
    c.about?.length ? `You have talked with this learner before and remember: ${c.about.join(" ")} Where it fits the chat, ask about one of these or link the topic to it, one thing at a time; never list what you know.` : "",
    `Stay in character. \`reply\`: ${c.course.name} only, 1–2 short sentences suited to ${c.level}, in your own manner. Always ${c.course.name}, even when the learner or the goal is written in another language. \`translation\`: the reply in ${native}.`,
    free
      ? "Keep the chat going: react to what the learner just said and ask one follow-up question about the topic or their experience with it."
      : `Pace the scene so it lasts about ${CHAT_MIN_TURNS}–${CHAT_MAX_TURNS} learner messages: one small step per turn, with realistic details to sort out (names, dates, preferences, a small complication) and a question the learner has to answer. Never solve several steps at once.`,
    `\`correction\`: if the learner's last message has a mistake, the corrected sentence and a very short explanation in ${native}; otherwise "". Ignore capitalization and punctuation.`,
    free
      ? "`goal_reached`: keep it false unless the learner clearly says goodbye; then say goodbye in `reply`."
      : `\`goal_reached\`: the learner has sent ${sent} message${sent === 1 ? "" : "s"}. Before ${CHAT_MIN_TURNS} it must be false: keep the scene going with the next step. From then on, true once the learner has achieved the goal; then wrap up the scene politely in \`reply\`.`,
    ...(opts.rules ?? []),
    "Respond only with JSON matching the schema.",
  ].filter(Boolean).join("\n");
  const last = history[history.length - 1];
  const prompt = last
    ? `Conversation so far:\n${history.slice(-(opts.keep ?? history.length)).map((m) => `${m.from === "ai" ? ch.name : "Learner"}: ${m.text}`).join("\n")}\n\n` +
      `Check only this last learner message for \`correction\` (earlier ones were already corrected): "${last.text}"\nThen write ${ch.name}'s next turn.`
    : free ? "Open the chat: a short, friendly greeting and a first question about the topic."
    : "Open the scene: a short greeting that leads straight into the goal and invites the learner to start.";
  return generate(turnSchema, system, prompt, undefined, looseTurn);
}

/** Rehearsal: the next in-role turn as `brief.who`. No correction, no goal, and no learner facts: the brief is the whole context. */
export function rehearseTurn(c: Base, brief: RehearsalBrief, history: ChatMsg[]) {
  const who = brief.who.trim();
  const prompt = history.length
    ? `Conversation so far:\n${history.map((m) => `${m.from === "ai" ? who : "Learner"}: ${m.text}`).join("\n")}\n\nWrite ${who}'s next turn.`
    : "Open the conversation the way it would really start.";
  return generate(roleTurnSchema, rehearsalSystem(c, brief), prompt, undefined, looseRoleTurn);
}

/** Structure drill (#43): asks whether the learner attempted `goal` in their spoken turns. */
export const avoidancePass = (c: Base, goal: string, learnerTurns: string[]) =>
  generate(avoidanceSchema, systemPrompt(c), avoidancePrompt(c.course.name, goal, learnerTurns), undefined, looseAvoidance);

/** One call after the learner steps out of role; entries that point at no turn are dropped. */
export async function debrief(c: Base, brief: RehearsalBrief, learnerTurns: string[]) {
  const d = await generate(debriefSchema, debriefSystem(c), debriefPrompt(c, brief, learnerTurns), undefined, looseDebrief);
  return cleanDebrief(d, learnerTurns.length);
}

// ---- Guidebook (DECISIONS B8): the unit's vocabulary and grammar, explained once and cached ----

const guideSchema = z.object({
  vocabulary: z.array(z.object({ word: z.string(), translation: z.string(), example: z.string(), example_translation: z.string() })),
  grammar: z.array(z.object({ pattern: z.string(), explanation: z.string(), example: z.string() })),
});
export type Guide = z.infer<typeof guideSchema>;
export const unitWords = (u: Unit) => [...new Set(u.steps.flatMap((s) => s.vocabulary))];
export const unitGrammar = (u: Unit) => [...new Set(u.steps.flatMap((s) => s.grammar.map((g) => g.pattern)))];

export async function loadGuide(enrollmentId: number, c: Base, unit: Unit): Promise<Guide> {
  const key = `guide:${unit.id}`;
  const cached = await getCached<Guide>(enrollmentId, key);
  if (cached) return cached;
  const g = await generate(guideSchema, systemPrompt(c), [
    `Write a study guide for the unit "${unit.title}".`,
    `vocabulary: one entry per word, in this order: ${unitWords(unit).join(", ")}. \`translation\` in the learner's language; \`example\` a short ${c.level} sentence using it, with \`example_translation\`.`,
    `grammar: one entry per pattern, in this order: ${unitGrammar(unit).join(" | ")}. \`explanation\`: 1–2 plain sentences in the learner's language; \`example\`: one target-language sentence.`,
  ].join("\n"));
  await putCached(enrollmentId, key, g);
  return g;
}

// ---- Word lookup (#28): course guidebooks first, then one AI call, cached per word and enrollment ----

// ponytail: per app run, so a word seen again opens without a db read and a double tap shares one call
const looked = new Map<string, Promise<Lookup>>();

export function lessonWord(enrollmentId: number, c: Base, word: string, sentence: string): Promise<Lookup> {
  const key = wordKey(word, c.course.iso), mk = `${enrollmentId}:${key}`;
  let p = looked.get(mk);
  if (!p) {
    p = (async () => {
      const hit = await getCached<Lookup>(enrollmentId, key) ?? fromGuides(await cachedGuides<Guide>(enrollmentId), word, c.course.iso);
      if (hit) return hit;
      const r = await generate(lookupSchema, systemPrompt(c), [
        `The learner tapped the word "${word}" in: "${sentence}".`,
        `lemma: its dictionary form. translation: its meaning in this sentence, in ${langEn(c.native)}, 1–4 words. pos: its part of speech, in ${langEn(c.native)}.`,
        `example: a short new ${c.level} sentence using it, with example_translation.`,
      ].join("\n"));
      await putCached(enrollmentId, key, r);
      return r;
    })();
    looked.set(mk, p);
    p.catch(() => looked.delete(mk)); // a failed lookup can be tried again
  }
  return p;
}

// ---- Tutor call: the tutor's reply to one event ----

/** With `onText` the reply streams (SPR-13); see generateStream. */
export function tutorTurn(c: Base & { about?: string[]; coach?: string }, who: CharacterId, unit: Unit, history: TutorMsg[], notes: string, event: TutorEvent, screen = "",
  onText?: (raw: string) => boolean) {
  const ch = CHARACTERS[who];
  const system = tutorSystem({
    name: ch.name, persona: ch.persona, target: c.course.name, native: langEn(c.native), level: c.level,
    unit: unit.title, words: unitWords(unit), grammar: unitGrammar(unit), about: c.about ?? [],
  });
  const prompt = tutorPrompt(ch.name, history, notes, event, screen, c.coach);
  return onText ? generateStream(tutorSchema, system, prompt, onText, looseTutor) : generate(tutorSchema, system, prompt, undefined, looseTutor);
}

// ---- Profile memory (SPR-22): after a conversation, keep what is worth knowing about the learner ----

/** Facts for one call, chat or lesson (SPR-23); counts as a use of each. Empty when memory is off; never throws. */
export async function learnerFacts(profileId: number): Promise<string[]> {
  try {
    if (!(await memoryOn(profileId))) return [];
    const picked = pickMemories(await listMemories(profileId));
    await markMemoriesUsed(picked.map((m) => m.id));
    return picked.map((m) => m.text);
  } catch (e) { console.error("memory", e); return []; }
}

/** Background work after a finished call or chat; resolves to the number of new facts (for a toast).
 *  Never throws: a lost memory must not break the lesson. */
export async function rememberSession(profileId: number, native: string, source: MemorySource, otherName: string, lines: { from: "me" | "other"; text: string }[]) {
  try {
    if (!lines.some((l) => l.from === "me") || !(await memoryOn(profileId))) return 0;
    const saved = await listMemories(profileId);
    const raw = await generate(memorySchema, memorySystem(langEn(native)), memoryPrompt(saved, lines, otherName), undefined, looseMemory);
    const ops = cleanOps(saved, raw);
    await applyMemoryOps(profileId, source, ops);
    return ops.add.length;
  } catch (e) { console.error("memory", e); return 0; }
}

// ---- Practice together: one call per unit, cached ----

export async function loadPractice(enrollmentId: number, c: Base, unit: Unit): Promise<PracticeSet> {
  const key = `practice:${unit.id}`;
  const cached = await getCached<PracticeSet>(enrollmentId, key);
  if (cached) return cached;
  const out = await generate(practiceSchema, systemPrompt(c), practicePrompt(unit.title, unitWords(unit), unitGrammar(unit)));
  const raw = toPracticeSet(out as Record<string, unknown>, [c.course.iso, c.native]), all = [...raw.warmup, ...raw.comprehension];
  const bad = await flagged({ ...c, step: unit }, all, raw.reading.text), ok = (it: Item) => !bad.has(all.indexOf(it));
  const set = { ...raw, warmup: raw.warmup.filter(ok), comprehension: raw.comprehension.filter(ok) };
  if (!set.warmup.length && !set.comprehension.length && !set.discussion.length) throw new Error("The model returned no usable exercises.");
  await putCached(enrollmentId, key, set);
  return set;
}

// ---- Garden note: one short message, rewritten every NOTE_DAYS or when the roots' mood changes ----

export async function loadGardenNote(enrollmentId: number, profileId: number, lang: string, info: NoteInfo, day: string): Promise<string> {
  const cached = await getCached<GardenNote>(enrollmentId, NOTE_KEY);
  if (noteFresh(cached, day, info.mood, lang)) return cached!.text;
  const text = cleanNote(await generatePlain(noteSystem(langEn(lang)), notePrompt(info, await learnerFacts(profileId))));
  if (!text) throw new Error("empty garden note");
  await putCached(enrollmentId, NOTE_KEY, noteFor(text, day, info.mood, lang));
  return text;
}
