// Run: pnpm test  (node --test, native TS type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCourse, buildPath, levelRange, parseStoryId, storyId } from "./course.ts";

const en = readFileSync(new URL("../courses/en.yml", import.meta.url), "utf8");

test("bundled courses/en.yml is valid and builds a sequential A1 path", () => {
  const c = parseCourse(en, "en.yml");
  const { units, remaining } = buildPath(c.levels.A1!, "A1", new Set([c.levels.A1!.units[0].steps[0].id]));
  const nodes = units.flatMap((u) => u.nodes.filter((n) => n.kind === "step"));
  assert.deepEqual(nodes.slice(0, 3).map((n) => n.state), ["done", "current", "locked"]);
  assert.equal(remaining, nodes.length - 1);
  assert.equal(units.at(-1)!.nodes.at(-1)!.kind, "checkpoint");
});

// Grows with the course: A1-B2, then C1, then C2.
const EXPECTED_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

test("en.yml has every expected CEFR level in order, each with 10 units and a checkpoint", () => {
  const c = parseCourse(en, "en.yml");
  assert.deepEqual(Object.keys(c.levels), EXPECTED_LEVELS);
  for (const lv of EXPECTED_LEVELS) {
    const level = c.levels[lv as keyof typeof c.levels]!;
    assert.equal(level.units.length, 10, `${lv} units`);
    assert.ok(level.checkpoint, `${lv} checkpoint`);
    assert.ok(level.checkpoint.activities.length >= 4, `${lv} checkpoint activities`);
    for (const u of level.units) assert.ok(u.steps.length >= 4 && u.steps.length <= 5, `${lv}/${u.id} has ${u.steps.length} steps`);
  }
});

test("en.yml step ids are unique and every step carries vocabulary or grammar", () => {
  const c = parseCourse(en, "en.yml");
  const ids = Object.values(c.levels).flatMap((l) => l!.units.flatMap((u) => u.steps.map((s) => s.id)));
  assert.equal(new Set(ids).size, ids.length);
  for (const [lv, level] of Object.entries(c.levels))
    for (const u of level!.units) for (const s of u.steps) {
      assert.ok(s.vocabulary.length + s.grammar.length > 0, `${lv}/${s.id}: no vocabulary and no grammar`);
      assert.ok(s.vocabulary.every((w) => w.trim()), `${lv}/${s.id}: blank vocabulary entry`);
      assert.ok(s.grammar.every((g) => g.pattern.trim()), `${lv}/${s.id}: blank grammar pattern`);
    }
});

test("en.yml per-level step counts stay in the range of B2", () => {
  const c = parseCourse(en, "en.yml");
  const b2 = c.levels.B2!.units.flatMap((u) => u.steps).length;
  for (const [lv, level] of Object.entries(c.levels)) {
    const n = level!.units.flatMap((u) => u.steps).length;
    assert.ok(n >= b2 - 3 && n <= b2 + 3, `${lv} has ${n} steps (B2 has ${b2})`);
  }
});

test("broken YAML fails with file, path and reason", () => {
  const bad = (text: string, re: RegExp) => assert.throws(() => parseCourse(text, "x.yml"), re);
  bad("name: A\nname: B\n", /x\.yml: Map keys must be unique at line 2/);
  bad(en.replace("type: match", "type: quiz"), /x\.yml:[\s\S]*levels\.A1\.units\[0\]\.steps\[0\]\.activities\[2\]\.type/);
  bad(en.replace("id: introduce-yourself", "id: basic-greetings"), /duplicate step id "basic-greetings"/);
  bad(en.replace("vocabulary: [one,", "vocab: [one,"), /vocab/);
});

// Smaller courses: every level has the same shape as en.yml's A1, so the path, chests and checkpoint work unchanged.
// Add a level here when a course grows (#4–#6: fr, de, tr A2).
const LEVELS: Record<string, string[]> = { es: ["A1", "A2", "B1", "B2", "C1", "C2"], fr: ["A1", "A2", "B1", "B2", "C1", "C2"], de: ["A1", "A2", "B1", "B2", "C1", "C2"], tr: ["A1", "A2", "B1", "B2", "C1", "C2"], hu: ["A1", "A2", "B1", "B2", "C1", "C2"] };
for (const [iso, levels] of Object.entries(LEVELS)) test(`courses/${iso}.yml has ${levels.join(", ")}: 10 units × 4 steps and a checkpoint each`, () => {
  const c = parseCourse(readFileSync(new URL(`../courses/${iso}.yml`, import.meta.url), "utf8"), `${iso}.yml`);
  assert.equal(c.iso, iso);
  assert.deepEqual(Object.keys(c.levels), levels);
  assert.equal(levelRange(c), levels.length > 1 ? `${levels[0]}–${levels.at(-1)}` : levels[0]);
  for (const lv of levels) {
    const level = c.levels[lv as keyof typeof c.levels]!;
    assert.deepEqual(level.units.map((u) => u.steps.length), Array(10).fill(4), lv);
    assert.ok(level.checkpoint && level.units.every((u) => u.steps.every((st) => st.vocabulary.length + st.grammar.length > 0)), lv);
  }
});

test("level range: one level alone, several as first–last", () => {
  assert.equal(levelRange(parseCourse(en, "en.yml")), "A1–C2");
});

test("story ids carry the level, since unit ids repeat across levels (#27)", () => {
  assert.deepEqual(parseStoryId(storyId("B2", "society-and-environment")), { level: "B2", unit: "society-and-environment" });
  assert.equal(parseStoryId("story:greetings"), null); // pre-1.9 id: only a progress key now, never opened
  assert.equal(parseStoryId("story:Z9:greetings"), null);
});
