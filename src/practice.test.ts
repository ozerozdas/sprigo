import { test } from "node:test";
import assert from "node:assert/strict";
import type { Course } from "./course.ts";
import type { Item } from "./activities.ts";
import {
  accepts, answer, begin, currentItem, describePractice, findTopic, needsJudge, next, openPractice, practiceSchema, practiceTopics, toPracticeSet,
  type PracticeSet,
} from "./practice.ts";

const step = (id: string) => ({ id, title: id, vocabulary: [], grammar: [], activities: [{ type: "learn" }] });
const course = {
  iso: "en", name: "English",
  levels: {
    A1: { title: "A1", units: [{ id: "u1", title: "Greetings", steps: [step("s1"), step("s2")] }, { id: "u2", title: "Food", steps: [step("s3")] }] },
    A2: { title: "A2", units: [{ id: "u3", title: "Travel", steps: [step("s4")] }] },
  },
} as unknown as Course;
const titles = (ts: { unit: { title: string } }[]) => ts.map((t) => t.unit.title);

test("topics: finished units up to the learner's level, else the current unit", () => {
  assert.deepEqual(titles(practiceTopics(course, "A1", new Set(["s1", "s2"]))), ["Greetings"]);
  assert.deepEqual(titles(practiceTopics(course, "A1", new Set(["s1", "s2", "s3", "s4"]))), ["Greetings", "Food"]);
  assert.deepEqual(titles(practiceTopics(course, "A2", new Set(["s1", "s2", "s3", "s4"]))), ["Greetings", "Food", "Travel"]);
  assert.deepEqual(titles(practiceTopics(course, "A1", new Set())), ["Greetings"]);
  assert.equal(practiceTopics(course, "A2", new Set(["s1", "s2"]))[0].level, "A1");
});

test("findTopic: exact title or a sentence that names it", () => {
  const ts = practiceTopics(course, "A1", new Set(["s1", "s2", "s3"]));
  assert.equal(findTopic(ts, "food")?.unit.id, "u2");
  assert.equal(findTopic(ts, "Let's do Greetings, please")?.unit.id, "u1");
  assert.equal(findTopic(ts, "sports"), undefined);
});

const raw = {
  warmup_blank: [{ prompt: "Fill in", sentence_with_blank: "I ___ tea.", options: ["like", "likes", "liking"], answer_index: 0 }],
  warmup_choice: [{ prompt: "Pick the fruit", options: ["apple", "bread", "milk"], answer_index: 0 }],
  warmup_bank: [{ prompt: "Ben çay severim", answer_words: ["I", "like", "tea."], distractor_words: ["likes"] }],
  reading_title: "Breakfast", reading_text: "Tom eats bread every morning.",
  comprehension: [{ prompt: "What does Tom eat?", options: ["bread", "rice", "fish"], answer_index: 0 }],
  discussion: ["What do you eat in the morning?", " ", "Have you ever skipped breakfast?"],
};

test("the model's output parses and maps to a practice set", () => {
  assert.ok(practiceSchema.safeParse(raw).success);
  const set = toPracticeSet(raw, ["en", "tr"]);
  assert.deepEqual(set.warmup.map((i) => i.kind), ["choice", "choice", "bank"]);
  assert.deepEqual(set.reading, { title: "Breakfast", text: "Tom eats bread every morning." });
  assert.equal(set.comprehension.length, 1);
  assert.deepEqual(set.discussion, ["What do you eat in the morning?", "Have you ever skipped breakfast?"]);
});

const choice: Item = { kind: "choice", prompt: "Pick", context: "I ___ tea.", big: false, listen: "", options: ["like", "likes", "liking"], answer: 0 };
const bank: Item = { kind: "bank", prompt: "Ben çay severim", answer: ["I", "like", "tea."], bank: ["tea.", "likes", "I", "like"] };
const set: PracticeSet = { warmup: [choice, bank], reading: { title: "T", text: "Text." }, comprehension: [choice], discussion: ["Q1?", "Q2?"] };

test("flow: warm-up → reading → questions → discussion → done, one answer per item", () => {
  let st = begin(openPractice(), set);
  assert.equal(st.stage, "warmup");
  assert.equal(currentItem(st), choice);
  assert.equal(answer(st, "sports"), st, "not an option: ignored");
  st = answer(st, "2");
  assert.deepEqual(st.last, { correct: false, given: "likes", expected: "like" });
  assert.equal(answer(st, "like"), st, "already answered");
  st = answer(next(st), "I like tea");
  assert.deepEqual([st.last?.correct, st.score, st.total], [true, 1, 2]);
  st = next(st); assert.equal(st.stage, "reading"); assert.equal(currentItem(st), null);
  st = next(st); assert.equal(st.stage, "comprehension");
  st = next(answer(st, "LIKE")); assert.deepEqual([st.stage, st.i, st.score, st.total], ["discussion", 0, 2, 3]);
  st = next(st); assert.equal(st.i, 1);
  assert.equal(next(st).stage, "done");
});

test("flow skips empty stages", () => {
  assert.equal(begin(openPractice(), { ...set, warmup: [] }).stage, "reading");
  let st = next(begin(openPractice(), { ...set, warmup: [], comprehension: [] }));
  assert.equal(st.stage, "discussion");
  st = next(next(next(begin(openPractice(), { ...set, discussion: [] })))); // w0 → w1 → reading → comprehension
  assert.equal(next(answer(st, "like")).stage, "done");
});

test("accepts: an option's text or number for choices, any sentence for word tiles", () => {
  assert.ok(accepts(choice, "liking"));
  assert.ok(accepts(choice, "3"));
  assert.ok(!accepts(choice, "4"));
  assert.ok(!accepts(choice, "I think so"));
  assert.ok(accepts(bank, "I like tea"));
  assert.ok(!accepts(bank, " "));
});

test("word tiles in another order go to the AI, whose verdict grades them", () => {
  assert.ok(!needsJudge(bank, "I like tea."));
  assert.ok(needsJudge(bank, "tea. I like"));
  assert.ok(!needsJudge(choice, "likes"));
  const st = next(answer(begin(openPractice(), set), "1"));
  assert.equal(answer(st, "tea. I like", true).last?.correct, true);
  assert.equal(answer(st, "tea. I like", false).last?.correct, false);
});

test("an option's text wins over its number: clicking \"3\" in a numbers unit", () => {
  const nums = { kind: "choice", prompt: "three", options: ["3", "1", "2"], answer: 0 } as unknown as Item;
  const set: PracticeSet = { warmup: [nums], reading: { title: "", text: "" }, comprehension: [], discussion: [] };
  assert.equal(answer(begin(openPractice(), set), "3").last?.correct, true);
});

test("describePractice tells the tutor what is on screen", () => {
  const ts = practiceTopics(course, "A1", new Set(["s1", "s2", "s3"]));
  assert.match(describePractice(null, ts), /closed.*Greetings, Food/);
  assert.match(describePractice(openPractice(), ts), /exact title in `answer`/);
  const st = begin(openPractice(), set);
  const d = describePractice(st, ts);
  for (const s of ["warm-up", "1 of 2", "I ___ tea.", "1) like", "never say it", "leave `say` empty"]) assert.ok(d.includes(s), s);
  assert.match(describePractice(answer(st, "likes"), ts), /answered "likes": wrong/);
  let dis = next(next(next(answer(next(answer(st, "like")), "I like tea")))); // → reading → comprehension → discussion
  assert.equal(dis.stage, "discussion");
  assert.match(describePractice(dis, ts), /question 1 of 2: "Q1\?"/);
  assert.ok(!describePractice(dis, ts).includes("Q2?"), "the next question stays hidden, or the tutor asks it twice");
  dis = next(dis);
  assert.match(describePractice(dis, ts), /ask you this question/);
});
