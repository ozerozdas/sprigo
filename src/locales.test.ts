import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const load = (l: string) => JSON.parse(readFileSync(new URL(`./locales/${l}.json`, import.meta.url), "utf8"));
const flat = (o: Record<string, any>, p = ""): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));

const en = flat(load("en")), tr = flat(load("tr"));
const others = readdirSync(new URL("./locales/", import.meta.url)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((l) => l !== "en");

// i18next plural suffixes differ per language (tr has a single form), so compare the base keys.
const base = (rows: [string, string][]) => [...new Set(rows.map(([k]) => k.replace(/_(zero|one|two|few|many|other)$/, "")))].sort();

test("en and tr have identical key sets", () => {
  assert.deepEqual(base(en), base(tr));
});

// Garden theme: hearts -> drops, streak -> roots, freeze -> greenhouse, chest -> harvest basket.
test("no pre-garden wording in user-visible text", () => {
  const bad = (rows: [string, string][], re: RegExp) => rows.filter(([, v]) => re.test(v)).map(([k]) => k);
  assert.deepEqual(bad(en, /\b(hearts?|streaks?|chests?|freeze)\b/i), []);
  assert.deepEqual(bad(tr, /kalp|\bseri|sandık|dondur/i), []);
  const words: Record<string, RegExp> = {
    de: /\b(herz|herzen|serie|truhe)\b/i,
    es: /\b(corazón|corazones|racha|cofre)\b/i,
    fr: /\b(cœur|cœurs|série|coffre)\b/i,
    hu: /\bszív(ek|et)?\b|sorozat|láda|fagyaszt/i,
  };
  for (const l of others) if (words[l]) assert.deepEqual(bad(flat(load(l)), words[l]), [], l);
});

// Lily is a Duolingo character; the hotel receptionist is Mia.
test("no Duolingo character names in user-visible text", () => {
  for (const rows of [en, ...others.map((l) => flat(load(l)))]) assert.deepEqual(rows.filter(([, v]) => /\bLily\b/i.test(v)).map(([k]) => k), []);
});

const vars = (v: string) => [...new Set([...v.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort();
const strip = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");

for (const lang of others) {
  const rows = flat(load(lang));
  test(`${lang}: keys match en`, () => assert.deepEqual(base(rows), base(en)));

  test(`${lang}: placeholders match en`, () => {
    const collect = (r: [string, string][]) => {
      const m = new Map<string, Set<string>>();
      for (const [k, v] of r) { const s = m.get(strip(k)) ?? new Set(); vars(v).forEach((x) => s.add(x)); m.set(strip(k), s); }
      return m;
    };
    const want = collect(en), got = collect(rows);
    for (const [k, s] of want) assert.deepEqual([...(got.get(k) ?? [])].sort(), [...s].sort(), k);
  });

  test(`${lang}: has every plural category`, () => {
    const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    const have = new Set(rows.map(([k]) => k));
    const plural = new Set(en.filter(([k]) => /_one$|_other$/.test(k)).map(([k]) => strip(k)));
    for (const k of plural) {
      // A language may collapse to a single plain key (tr), but once it uses suffixes the set must be complete.
      if (have.has(k) || (have.has(`${k}_other`) && cats.every((c) => c === "other" || !have.has(`${k}_${c}`)) && cats.length === 1)) continue;
      for (const c of cats) assert.ok(have.has(`${k}_${c}`), `${k}_${c}`);
    }
  });

  test(`${lang}: has _meta.name`, () => assert.ok(String(load(lang)._meta?.name ?? "").trim()));
}

// The app was renamed to Sprigo.
test("no old app name in user-visible text", () => {
  for (const rows of [en, ...others.map((l) => flat(load(l)))]) assert.deepEqual(rows.filter(([, v]) => /loalingo/i.test(v)).map(([k]) => k), []);
});
