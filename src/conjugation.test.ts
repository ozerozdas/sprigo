import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, crossChecked, fromTable, pickAsks, tensesFor } from "./conjugation.ts";

test("a level drills its own tenses and every earlier one", () => {
  assert.deepEqual(tensesFor("es", "A1"), ["presente"]);
  assert.deepEqual(tensesFor("es", "A2"), ["presente", "pretérito indefinido", "pretérito imperfecto"]);
  assert.equal(tensesFor("es", "C2").length, tensesFor("es", "C1").length); // C2 adds nothing new
  assert.deepEqual(tensesFor("xx", "A1"), []);
  for (const iso of ["es", "fr", "de", "tr", "hu", "en"]) assert.ok(LANGS[iso].tenses.A1?.length, iso);
});

test("picks are distinct and within the level", () => {
  let n = 0; const rnd = () => (n = (n * 7 + 3) % 11) / 11;
  const asks = pickAsks("fr", "A1", 8, rnd);
  assert.equal(asks.length, 8);
  assert.equal(new Set(asks.map((a) => `${a.verb}|${a.person}|${a.tense}`)).size, 8);
  assert.ok(asks.every((a) => a.tense === "présent"));
});

test("only forms both answers agree on are asked; the pronoun may be typed too", () => {
  const asks = [{ verb: "avoir", person: "je", tense: "présent" }, { verb: "parler", person: "nous", tense: "présent" }, { verb: "être", person: "tu", tense: "présent" }];
  const items = crossChecked(asks, ["ai", " Parlons", "es"], ["ai", "parlons", "est"], "Conjugate");
  assert.deepEqual(items.map((x) => [x.kind === "input" && x.answer, x.kind === "input" && x.accepted]), [["ai", ["j'ai"]], ["Parlons", ["nous Parlons"]]]);
  assert.deepEqual(items[0].kind === "input" && items[0].cells, ["avoir", "je", "présent"]);
});

test("Hungarian tables: every verb has every határozatlan tense, and each listed tense has a form per person", () => {
  const hu = LANGS.hu, tenses = tensesFor("hu", "C2");
  for (const verb of hu.verbs) {
    for (const tense of tenses.filter((x) => x.endsWith("(határozatlan)"))) assert.ok(hu.forms![verb]?.[tense], `${verb} · ${tense}`);
    for (const [tense, row] of Object.entries(hu.forms![verb])) {
      assert.ok(tenses.includes(tense), `${verb}: unknown tense ${tense}`);
      assert.deepEqual(row.split(", ").map((f) => f.length > 0), hu.persons.map(() => true), `${verb} · ${tense}`);
    }
  }
});

test("a drill only asks what the tables have: no határozott forms of an intransitive verb", () => {
  let n = 0; const rnd = () => (n = (n * 7 + 3) % 31) / 31;
  for (let i = 0; i < 20; i++) for (const a of pickAsks("hu", "C2", 8, rnd)) assert.ok(LANGS.hu.forms![a.verb][a.tense], `${a.verb} · ${a.tense}`);
});

test("table items need no AI: the first form is asked, every listed form is accepted, with or without the pronoun", () => {
  const items = fromTable("hu", [{ verb: "olvas", person: "te", tense: "felszólító mód (határozott)" }, { verb: "kér", person: "ők", tense: "jelen idő (határozott)" }], "Type");
  assert.deepEqual(items?.map((x) => x.kind === "input" && [x.answer, x.accepted]), [["olvasd", ["olvassad", "te olvasd", "te olvassad"]], ["kérik", ["ők kérik"]]]);
  assert.deepEqual(items?.[1].kind === "input" && items[1].cells, ["kér", "ők", "jelen idő (határozott)"]);
  assert.equal(fromTable("es", [], "Type"), null);
});
