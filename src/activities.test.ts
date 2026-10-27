import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, givesAway, hideAnswer, matchesAnswer, plannedActivities, lessonSchema, checkPrompt, rejected, solvePrompt, toItems, type Item } from "./activities.ts";

test("answer check ignores case, punctuation and curly quotes; accepts variants", () => {
  const item = { answer: "I'm fine, thank you.", accepted: ["I am fine, thanks"] };
  assert.ok(matchesAnswer("im fine thank you", item) === false); // apostrophe is meaningful
  assert.ok(matchesAnswer("i’m FINE thank you!", item));
  assert.ok(matchesAnswer("I am fine thanks", item));
  assert.ok(!matchesAnswer("I'm fine", item));
});

test("lesson plan skips v1-unsupported types, applies default count, validates and maps output", () => {
  const acts = plannedActivities([{ type: "video_call" }, { type: "word_select", count: 1 }, { type: "match" }]);
  assert.deepEqual(acts.map((a) => [a.key, a.type, a.count]), [["a0", "word_select", 1], ["a1", "match", 2]]);
  const out = lessonSchema(acts).parse({
    a0: [{ prompt: "Hello?", options: ["Merhaba", "Hoşça kal", "Evet", "Hayır"], answer_index: 0 }],
    a1: [{ pairs: [{ target: "hi", native: "selam" }, { target: "bye", native: "güle güle" }, { target: "yes", native: "evet" }] }],
  });
  const items = toItems(acts, out as any, ["en", "tr"]);
  assert.equal(items.length, 2);
  assert.ok(items[0].kind === "choice" && items[0].options[items[0].answer] === "Merhaba");
  assert.throws(() => lessonSchema(acts).parse({ a0: [{ prompt: "x", options: ["a", "b", "c"], answer_index: 7 }], a1: [] }));
  // Out-of-range index slips past the schema when options < 4: toItems drops it instead of crashing.
  assert.equal(toItems(acts, { a0: [{ prompt: "x", options: ["a", "b", "c"], answer_index: 3 }], a1: [] }, ["en", "tr"]).length, 0);
});

test("an item with a letter from an alphabet neither language uses is dropped", () => {
  const acts = plannedActivities([{ type: "translate", count: 3 }]);
  const item = (answer: string, prompt = "Translate") => ({ prompt, source_sentence: "In ten minutes.", answer, accepted_answers: [] });
  const kept = (items: object[], langs: string[]) => toItems(acts, { a0: items }, langs).length;
  assert.equal(kept([item("Tíz perccel後に."), item("Az emiatt késett."), item("Az емiatt késett.")], ["hu", "en"]), 1);
  assert.equal(kept([item("Tíz perc múlva.", "Переведите"), item("Tíz perc múlva.", "翻訳してください")], ["hu", "ru"]), 1);
  assert.equal(kept([item("Tíz perc múlva.", "次の文を翻訳してください")], ["hu", "ja"]), 1);
});

test("the second look checks every exercise with its answer, and solves choice questions without the key", () => {
  const items: Item[] = [
    { kind: "learn", phrase: "Örülök!", translation: "Miło mi!", note: "Przy poznaniu kogoś." },
    { kind: "choice", prompt: "Wybierz:", context: "Köszönöm, ___ vagyok.", big: false, listen: "", options: ["enél", "jól", "hogy"], answer: 0 },
    { kind: "bank", prompt: "Miło mi", answer: ["Örülök", "nek"], bank: ["hogy", "nek", "Örülök", "vagyok"] },
  ];
  const c = { course: { name: "Hungarian" }, level: "A1", native: "pl", step: { title: "Introduce Yourself" } } as Parameters<typeof checkPrompt>[0];
  const check = checkPrompt(c, items, "Anna Budapesten lakik.");
  assert.match(check, /^Step: Introduce Yourself\nSome questions are about this text: Anna Budapesten lakik\./);
  assert.match(check, /\n1\. Teaches: Örülök! = Miło mi!/);
  assert.match(check, /\n2\. Wybierz: Köszönöm, ___ vagyok\. Options: enél \(correct\) \| jól \| hogy$/m);
  assert.match(check, /\n3\. Build from word tiles: Miło mi Answer: Örülök nek \(wrong tiles: hogy, vagyok\)$/);
  assert.doesNotMatch(checkPrompt(c, items), /about this text/);
  const solve = solvePrompt(c, items);
  assert.match(solve, /\nQuestion 2: Wybierz: Köszönöm, ___ vagyok\.\n  1\) enél\n  2\) jól\n  3\) hogy$/);
  assert.doesNotMatch(solve, /correct\)|Question [13]/);
  assert.equal(solvePrompt(c, [items[0], items[2]]), "");
});

test("an exercise is rejected when its check fails or its right options are not just its key", () => {
  const q = (answer: number): Item => ({ kind: "choice", prompt: "?", context: "", big: false, listen: "", options: ["a", "b", "c"], answer });
  const items: Item[] = [q(0), q(1), q(2), { kind: "speak", phrase: "Jó napot!", translation: "Dzień dobry!" }, q(0)];
  const ok = (exercise: number, fine = true) => ({ exercise, check: "", ok: fine });
  const right = (question: number, ...r: number[]) => ({ question, reasoning: "", right: r });
  assert.deepEqual([...rejected(items, { checks: [ok(1), ok(4, false)] }, null)], [3]);
  assert.deepEqual([...rejected(items, null, { answers: [right(1, 1), right(2, 1, 2), right(3, 1), right(4, 1), right(5)] })].sort(), [1, 2, 4]);
  assert.equal(rejected(items, null, null).size, 0);
});

test("listening practice picks the weakest words with 4 distinct options", async () => {
  const { listenItems } = await import("./activities.ts");
  const words = ["a", "b", "c", "d", "e"].map((w, i) => ({ word: w, translation: w.toUpperCase(), strength: i }));
  assert.deepEqual(listenItems(words.slice(0, 3), "?"), []);
  const items = listenItems(words, "?", 2);
  assert.deepEqual(items.map((i) => i.kind === "choice" && i.listen).sort(), ["a", "b"]);
  for (const it of items) {
    assert.ok(it.kind === "choice");
    assert.equal(new Set(it.options).size, 4);
    assert.equal(it.options[it.answer], it.listen);
  }
});

test("recent mistakes reach the lesson prompt as one line each", async () => {
  const { mistakeLine, lessonPrompt } = await import("./activities.ts");
  assert.equal(mistakeLine({ kind: "choice", prompt: "Hi?", context: "", big: false, listen: "", options: ["a", "b"], answer: 1 }), "Hi? → b");
  assert.equal(mistakeLine({ kind: "bank", prompt: "p", answer: ["I", "am"], bank: [] }), "p → I am");
  assert.equal(mistakeLine({ kind: "match", pairs: [] }), null);
  const c = { unitTitle: "U", step: { title: "S", vocabulary: [], grammar: [] } } as any;
  assert.ok(lessonPrompt(c, [], ["Hi? → b"]).includes("- Hi? → b"));
  assert.ok(!lessonPrompt(c, []).includes("got these wrong"));
});

test("what is known about the learner reaches the lesson prompt only when there is some", async () => {
  const { lessonPrompt } = await import("./activities.ts");
  const c = { unitTitle: "U", step: { title: "S", vocabulary: [], grammar: [] } } as any;
  assert.ok(lessonPrompt(c, [], [], ["Prefers DC to Marvel."]).includes("About the learner: Prefers DC to Marvel."));
  assert.ok(!lessonPrompt(c, []).includes("About the learner"));
});

test("word rush boards have 5 distinct pairs and need 5 words", async () => {
  const { madnessItems } = await import("./activities.ts");
  const words = Array.from({ length: 12 }, (_, i) => ({ word: `w${i}`, translation: `t${i}`, strength: 1 }));
  const items = madnessItems(words, 3);
  assert.equal(items.length, 3);
  for (const it of items) assert.ok(it.kind === "match" && new Set(it.pairs.map((p) => p[0])).size === 5 && it.pairs.every(([w, t]) => t === w.replace("w", "t")));
  assert.equal(madnessItems(words.slice(0, 4)).length, 0);
});

test("speaking check forgives order, case and punctuation but not missing words", async () => {
  const { speechScore, SPEECH_PASS } = await import("./activities.ts");
  assert.equal(speechScore("Nice to meet you!", " nice to meet you."), 1);
  assert.ok(speechScore("I'm fine, thank you.", "I'm fine thank you") >= SPEECH_PASS);
  assert.ok(speechScore("Good morning, how are you?", "good morning") < SPEECH_PASS);
  assert.equal(speechScore("thank thank", "thank"), 0.5, "each heard word counts once");
});

test("speaking check names the words it didn't catch", async () => {
  const { speechMisses } = await import("./activities.ts");
  assert.deepEqual(speechMisses("Good morning, how are you?", "good morning"), ["how", "are", "you"]);
  assert.deepEqual(speechMisses("I'm fine, thank you.", "you thank fine I'm"), []);
  assert.deepEqual(speechMisses("thank thank", "thank"), ["thank"]);
  assert.deepEqual(speechMisses("Hello!", ""), ["hello"]);
  assert.deepEqual(speechMisses("Jó napot kívánok!", "Jónapot kívánok."), [], "words the transcript joined still count");
  assert.deepEqual(speechMisses("Jó napot kívánok!", "Jónapot."), ["kívánok"]);
  assert.deepEqual(speechMisses("Guten Tag", "gutentag morgen"), []);
});

test("hideAnswer keeps only the meaning of a word-tile prompt", () => {
  const a = "They played football in the park yesterday.";
  assert.equal(hideAnswer(`'${a}' (Dün parkta futbol oynadılar.)`, a), "Dün parkta futbol oynadılar.");
  assert.equal(hideAnswer(`Dün parkta futbol oynadılar: "they played football in the park yesterday"`, a), "Dün parkta futbol oynadılar");
  assert.equal(hideAnswer("Dün parkta futbol oynadılar.", a), "Dün parkta futbol oynadılar.");
});

test("a choice question that names its own answer is dropped", () => {
  const opts = ["morning", "afternoon", "night", "evening"];
  assert.equal(givesAway('"evening" İngilizcede hangi kelimeye karşılık gelir?', opts, 3), true);
  assert.equal(givesAway('"Akşam" İngilizcede hangisidir?', opts, 3), false);
  assert.equal(givesAway("Which is right: morning or evening?", opts, 3), false); // both named: still a real choice
  assert.equal(REGISTRY.word_select!.toItem({ prompt: "'evening' means?", options: opts, answer_index: 3 }), null);
});

test("listening practice can ask a few words and draw wrong options from a larger pool", async () => {
  const { listenItems } = await import("./activities.ts");
  const pool = ["a", "b", "c", "d", "e"].map((w, i) => ({ word: w, translation: w.toUpperCase(), strength: i }));
  const items = listenItems([pool[4]], "?", 10, pool);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.ok(it.kind === "choice");
  assert.equal(it.listen, "e");
  assert.equal(new Set(it.options).size, 4);
  assert.equal(it.options[it.answer], "e");
  assert.deepEqual(listenItems([], "?", 10, pool), []);
  assert.deepEqual(listenItems([pool[0]], "?", 10, pool.slice(0, 3)), []);
});
