import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_PAUSE_MS, STATE_HINTS, coach, type SessionRow, baselineOf, learnerState, nativeCount, nextHint, speechMetrics, summarize, type Baseline, type LearnerState, type Utterance } from "./speech.ts";

const RATE = 16000;
/** `parts`: [ms, loud?] stretches of a 0.1 or silent signal. */
const signal = (parts: [number, boolean][]) => {
  const out = new Float32Array(parts.reduce((n, [ms]) => n + (ms * RATE) / 1000, 0));
  let o = 0;
  for (const [ms, loud] of parts) { const n = (ms * RATE) / 1000; if (loud) out.fill(0.1, o, o + n); o += n; }
  return out;
};

test("timing: speech span, pauses and the long ones; word gaps, edges and the end-of-turn quiet don't count", () => {
  const s = signal([[300, false], [1000, true], [100, false], [500, true], [400, false], [1000, true], [LONG_PAUSE_MS + 200, false], [1000, true], [800, false]]);
  const m = speechMetrics(s, RATE, "I usually wake up at seven", { latencyMs: 900 }, "tr", "en");
  assert.equal(m.speechMs, 5200);
  assert.equal(m.longPauses, 1);
  assert.ok(Math.abs(m.pauseRatio - 1600 / 5200) < 0.01);
  assert.equal(m.words, 6);
  assert.equal(m.wpm, Math.round(6 / (5200 / 60000)));
  assert.ok(Math.abs(m.level - 0.1) < 1e-6);
  assert.equal(m.latencyMs, 900);
});

test("fillers and native words are counted, not taken for target words", () => {
  const m = speechMetrics(signal([[1000, true]]), RATE, "Um, I... eee, bilmiyorum, ama I like it", { latencyMs: null }, "tr", "en");
  assert.equal(m.fillers, 2);
  assert.equal(m.words, 6);
  assert.equal(m.nativeWords, 2);
  assert.equal(nativeCount(["e", "que"], "es", "pt"), 0); // shared small words are not a switch
  assert.equal(nativeCount(["я", "не", "know"], "ru", "en"), 2);
  assert.equal(nativeCount(["ve"], "tr", "tr"), 0);
  assert.equal(nativeCount(["nie", "wiem", "hogy", "mam"], "pl", "hu"), 2);
});

test("silence gives zeros, not NaN", () => {
  const m = speechMetrics(new Float32Array(RATE), RATE, "", { latencyMs: null }, "tr", "en");
  assert.deepEqual([m.speechMs, m.wpm, m.pauseRatio, m.level], [0, 0, 0, 0]);
});

test("session summary averages what was said and sums the counts", () => {
  const base = { latencyMs: null, speechMs: 1000, words: 0, wpm: 0, pauseRatio: 0, longPauses: 0, level: 0, fillers: 1, nativeWords: 0 };
  const s = summarize([
    { ...base, latencyMs: 1000, words: 5, wpm: 100, pauseRatio: 0.2, longPauses: 1, level: 0.1 },
    { ...base, latencyMs: null, words: 3, wpm: 60, pauseRatio: 0.4, level: 0.3, nativeWords: 1 },
    base, // a cough: no words
  ], 2);
  assert.deepEqual({ ...s, pauseRatio: +s.pauseRatio.toFixed(2), level: +s.level.toFixed(2) },
    { utterances: 2, silences: 2, latencyMs: 1000, wpm: 80, pauseRatio: 0.3, longPauses: 1, level: 0.2, fillers: 3, words: 8, nativeWords: 1, speechMs: 3000 });
  assert.equal(summarize([], 0).latencyMs, null);
});

const U = (o: Partial<Utterance>): Utterance => ({ latencyMs: 1000, speechMs: 4000, words: 8, wpm: 120, pauseRatio: 0.2, longPauses: 0, level: 0.1, fillers: 0, nativeWords: 0, ...o });
const BASE: Baseline = { latencyMs: 1000, wpm: 120, pauseRatio: 0.2, words: 8 };

test("learner state, relative to the learner's own baseline", () => {
  const rows: [string, Utterance[], Baseline | null, LearnerState][] = [
    ["like usual", [U({}), U({}), U({})], BASE, "neutral"],
    ["one answer is not a trend", [U({ words: 1 })], BASE, "neutral"],
    ["slow to answer", [U({ latencyMs: 3000 }), U({ latencyMs: 2800 })], BASE, "hesitant"],
    ["short answers", [U({ words: 2 }), U({ words: 3 }), U({ words: 3 })], BASE, "hesitant"],
    ["slow and broken", [U({ wpm: 60, pauseRatio: 0.5 }), U({ wpm: 70, pauseRatio: 0.45 })], BASE, "struggling"],
    ["fast, few pauses, long answers", [U({ wpm: 150, pauseRatio: 0.1, words: 12 }), U({ wpm: 140, pauseRatio: 0.12, words: 10 })], BASE, "flowing"],
    ["native words win, even with no baseline", [U({ words: 4, nativeWords: 2 }), U({ words: 4, nativeWords: 1 })], null, "l1_fallback"],
    ["no baseline yet", [U({ latencyMs: 5000 }), U({ latencyMs: 5000 })], null, "neutral"],
    ["only the last 3 count", [U({ words: 1 }), U({ words: 1 }), U({}), U({}), U({})], BASE, "neutral"],
    ["empty answers are skipped", [U({ words: 2 }), U({ words: 0 }), U({ words: 2 })], BASE, "hesitant"],
    ["a near-silent usual doesn't make any pause look like struggle", [U({ wpm: 80, pauseRatio: 0.06 }), U({ wpm: 80, pauseRatio: 0.06 })], { ...BASE, pauseRatio: 0 }, "neutral"],
  ];
  for (const [name, us, base, want] of rows) assert.equal(learnerState(us, base), want, name);
});

test("in-call baseline needs a few answers", () => {
  assert.equal(baselineOf([U({}), U({ words: 0 }), U({})]), null);
  const b = baselineOf([U({}), U({ latencyMs: null }), U({ wpm: 90 })])!;
  assert.deepEqual({ ...b, pauseRatio: +b.pauseRatio.toFixed(2) }, { latencyMs: 1000, wpm: 110, pauseRatio: 0.2, words: 8 });
});

test("hint only on a change or every 3rd turn the state holds", () => {
  let prev = { state: "neutral" as LearnerState, turns: 0 };
  const got = (["neutral", "hesitant", "hesitant", "hesitant", "hesitant", "flowing", "neutral"] as LearnerState[]).map((st) => {
    const r = nextHint(prev, st); prev = r.prev; return r.hint ? st : "-";
  });
  assert.deepEqual(got, ["-", "hesitant", "-", "-", "hesitant", "flowing", "-"]);
  assert.ok(STATE_HINTS.hesitant.includes("sentence starter"));
});

const row = (o: Partial<SessionRow>): SessionRow => ({ utterances: 10, latency_ms: 2000, wpm: 100, long_pauses: 2, words: 80, native_words: 0, ...o });

test("coach: needs a few calls, then shows the biggest improvements and a tip from the latest calls", () => {
  assert.equal(coach([row({}), row({}), row({ utterances: 0 })]), null);
  const c = coach([
    row({ latency_ms: 4100, words: 40 }), row({ latency_ms: 4000, words: 40 }),
    row({ latency_ms: 3000, words: 50 }), // the odd middle one is in neither half
    row({ latency_ms: 2300, words: 70, wpm: 105 }), row({ latency_ms: 2300, words: 70, wpm: 105 }),
  ])!;
  assert.deepEqual(c.trends.map((x) => x.k), ["words", "latency"]); // +75%, −44%; wpm +5% is under the bar
  assert.equal(c.trends[0].from, 4); assert.equal(c.trends[0].to, 7);
  assert.ok(Math.abs(c.trends[1].from - 4.05) < 1e-9);
  assert.equal(c.tip, "stretch");
});

test("coach: no progress means no trends; the tip follows the weakest spot", () => {
  const same = (o: Partial<SessionRow>) => coach([row(o), row(o), row(o)])!;
  assert.deepEqual(same({}).trends, []);
  assert.equal(same({ native_words: 20 }).tip, "native");
  assert.equal(same({ words: 30 }).tip, "short");
  assert.equal(same({ long_pauses: 6 }).tip, "pauses");
  assert.deepEqual(coach([row({ latency_ms: null }), row({}), row({})])!.trends, []); // a call with no latency doesn't break it
});
