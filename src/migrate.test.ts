import { test } from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { FutureSchemaError, runMigrations, schemaVersion, type Migration } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { wrapSqlJs } from "./sqljs.ts";
import { USAGE_SQL } from "./usage.ts";

const SQL = await initSqlJs();
const fresh = () => wrapSqlJs(new SQL.Database());
const tables = async (db: ReturnType<typeof fresh>) =>
  (await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);

const TABLES = ["ai_usage", "bookmarks", "content_cache", "device_settings", "enrollments", "journal", "memories", "mistakes", "profiles", "speech_sessions", "step_progress", "tutors", "unit_notes", "words"];

/** Every table's rows, with row order normalised so snapshots compare independent of it. */
const snapshot = async (db: ReturnType<typeof fresh>) => {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of await tables(db))
    out[t] = (await db.select<Record<string, unknown>>(`SELECT * FROM ${t}`)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return out;
};

test("empty database migrates to the latest version", async () => {
  const db = fresh();
  const r = await runMigrations(db, MIGRATIONS);
  const latest = Math.max(...MIGRATIONS.map((m) => m.v));
  assert.deepEqual(r, { from: 0, to: latest });
  assert.equal(await schemaVersion(db), latest);
  for (const t of TABLES) assert.ok((await tables(db)).includes(t), `table ${t} exists`);
});

test("existing pre-migration database (tables, user_version 0) keeps its data", async () => {
  const db = fresh();
  await db.execute(MIGRATIONS[0].sql); // what 0.1.x created, without user_version
  await db.execute("INSERT INTO device_settings(key, value) VALUES ($1, $2)", ["k", "v"]);
  assert.equal(await schemaVersion(db), 0);
  await runMigrations(db, MIGRATIONS);
  assert.equal(await schemaVersion(db), Math.max(...MIGRATIONS.map((m) => m.v)));
  assert.deepEqual(await db.select("SELECT key, value FROM device_settings"), [{ key: "k", value: "v" }]);
});

test("running twice is a no-op", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  const again = await runMigrations(db, MIGRATIONS);
  assert.equal(again.from, again.to);
});

test("pending migrations apply in order", async () => {
  const db = fresh();
  const ms: Migration[] = [
    { v: 2, sql: "INSERT INTO t(x) VALUES ('two')" },
    { v: 1, sql: "CREATE TABLE t(x TEXT)" },
  ];
  await runMigrations(db, ms);
  assert.equal(await schemaVersion(db), 2);
  assert.deepEqual(await db.select("SELECT x FROM t"), [{ x: "two" }]);
});

test("a newer schema than the app knows throws FutureSchemaError and changes nothing", async () => {
  const db = fresh();
  await db.execute("PRAGMA user_version = 99");
  await assert.rejects(runMigrations(db, MIGRATIONS), (e: unknown) => e instanceof FutureSchemaError && e.found === 99 && e.known === Math.max(...MIGRATIONS.map((m) => m.v)));
  assert.equal(await schemaVersion(db), 99);
  assert.deepEqual(await tables(db), []);
});

test("a failing migration rolls back and keeps the previous version", async () => {
  const db = fresh();
  const ms: Migration[] = [
    { v: 1, sql: "CREATE TABLE a(x TEXT)" },
    { v: 2, sql: "CREATE TABLE b(x TEXT); INSERT INTO nope VALUES (1)" },
  ];
  await assert.rejects(runMigrations(db, ms));
  assert.equal(await schemaVersion(db), 1);
  assert.deepEqual(await tables(db), ["a"], "table b from the failed migration is rolled back");
});

test("backup runs once before migrating a database that has tables, never for an empty one", async () => {
  const calls: number[] = [];
  const backup = async (v: number) => { calls.push(v); };
  const ms: Migration[] = [{ v: 1, sql: "CREATE TABLE a(x TEXT)" }, { v: 2, sql: "CREATE TABLE b(x TEXT)" }];

  const empty = fresh();
  await runMigrations(empty, ms, backup);
  assert.deepEqual(calls, [], "no backup for a brand-new database");

  const old = fresh();
  await runMigrations(old, ms.slice(0, 1));
  await runMigrations(old, ms, backup);
  assert.deepEqual(calls, [2], "one backup, named after the target version");

  await runMigrations(old, ms, backup);
  assert.deepEqual(calls, [2], "no backup when nothing is pending");
});

test("v4: speech_sessions has nullable conditions and avoided", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  const cols = await db.select<{ name: string; notnull: number }>("PRAGMA table_info(speech_sessions)");
  for (const c of ["conditions", "avoided"]) assert.equal(cols.find((x) => x.name === c)?.notnull, 0, c);
});

test("v7: bookmarks are one row per enrollment, kind and ref", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  await db.execute("INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats) VALUES (1, 'a', 'green', 'en', 'en', '{}')");
  await db.execute("INSERT INTO enrollments(id, profile_id, course_iso, level) VALUES (1, 1, 'es', 'A1')");
  const insert = "INSERT INTO bookmarks(enrollment_id, kind, ref) VALUES (1, $1, $2) ON CONFLICT DO NOTHING";
  await db.execute(insert, ["unit", "A1:greetings"]);
  await db.execute(insert, ["unit", "A1:greetings"]);
  await db.execute(insert, ["guide", "A1:greetings"]);
  assert.deepEqual(await db.select("SELECT kind, ref FROM bookmarks ORDER BY kind"), [{ kind: "guide", ref: "A1:greetings" }, { kind: "unit", ref: "A1:greetings" }]);
  await db.execute("DELETE FROM bookmarks WHERE enrollment_id = 1 AND kind = 'unit' AND ref = 'A1:greetings'");
  assert.deepEqual(await db.select("SELECT kind FROM bookmarks"), [{ kind: "guide" }]);
});

test("v8: ai_usage defaults created_at and rolls up by local month, feature and model", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  await db.execute(`INSERT INTO ai_usage(provider, model, feature, input_tokens, output_tokens, created_at) VALUES
    ('openai', 'gpt-4o-mini', 'lesson', 100, 20, '2026-01-15 12:00:00'),
    ('openai', 'gpt-4o-mini', 'lesson', 50, 10, '2026-01-16 12:00:00'),
    ('ollama', 'qwen3:8b', 'check', 7, 3, '2026-02-01 12:00:00'),
    ('anthropic', 'claude-sonnet-4.5', 'tutor', 1, 2, '2026-02-01 12:00:00')`);
  await db.execute("INSERT INTO ai_usage(provider, model, feature, input_tokens, output_tokens) VALUES ('gemini', 'gemini-2.5-flash', 'guide', 1, 1)");
  const rows = await db.select<{ month: string; feature: string; provider: string; model: string; input_tokens: number; output_tokens: number }>(USAGE_SQL);
  assert.deepEqual(rows.filter((r) => r.month === "2026-01"), [
    { month: "2026-01", feature: "lesson", provider: "openai", model: "gpt-4o-mini", input_tokens: 150, output_tokens: 30 },
  ]);
  assert.deepEqual(rows.filter((r) => r.month === "2026-02").map((r) => r.feature).sort(), ["check", "tutor"]);
  const [now] = await db.select<{ created_at: string }>("SELECT created_at FROM ai_usage WHERE feature = 'guide'");
  assert.match(now.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test("v9: custom tutors are one package per profile, with a source and a timestamp", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  await db.execute("INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats) VALUES (1, 'a', 'green', 'en', 'en', '{}')");
  await db.execute("INSERT INTO tutors(id, profile_id, data) VALUES ('custom:1', 1, '{}')");
  await db.execute("INSERT INTO tutors(id, profile_id, data, avatar, scene, source) VALUES ('custom:2', 1, '{}', 'data:image/png;base64,x', NULL, 'imported')");
  const rows = await db.select<{ id: string; source: string; avatar: string | null; created_at: string }>("SELECT id, source, avatar, created_at FROM tutors ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.id, r.source, r.avatar]), [["custom:1", "local", null], ["custom:2", "imported", "data:image/png;base64,x"]]);
  for (const r of rows) assert.match(r.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  await assert.rejects(db.execute("INSERT INTO tutors(id, profile_id, data) VALUES ('custom:1', 1, '{}')"), "the id is the primary key");
});

test("v5 seeds FSRS state from word strength and keeps every word", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS.filter((m) => m.v <= 4));
  await db.execute("INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats) VALUES (1, 'a', 'green', 'en', 'en', '{}')");
  await db.execute("INSERT INTO enrollments(id, profile_id, course_iso, level) VALUES (1, 1, 'es', 'A1')");
  for (const [w, s] of [["uno", 0], ["una", 1], ["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5]] as const)
    await db.execute("INSERT INTO words(enrollment_id, word, translation, strength, updated_at) VALUES (1, $1, 'x', $2, '2026-01-01 00:00:00')", [w, s]);
  await runMigrations(db, MIGRATIONS);
  const rows = await db.select<Record<string, unknown>>("SELECT word, state, stability, difficulty, reps, lapses, due, last_review FROM words ORDER BY strength, word");
  assert.equal(rows.length, 6);
  for (const [i, word] of ["uno", "una"].entries()) {
    const { due: newDue, ...fresh0 } = rows[i];
    assert.deepEqual(fresh0, { word, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last_review: null });
    assert.match(String(newDue), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  }
  const seeded = (word: string, stability: number, reps: number, due: string) =>
    ({ word, state: 2, stability, difficulty: 5, reps, lapses: 0, due, last_review: "2026-01-01 00:00:00" });
  assert.deepEqual(rows.slice(2), [
    seeded("dos", 1, 1, "2026-01-02 00:00:00"),
    seeded("tres", 3, 2, "2026-01-04 00:00:00"),
    seeded("cuatro", 7, 3, "2026-01-08 00:00:00"),
    seeded("cinco", 15, 4, "2026-01-16 00:00:00"),
  ]);
});

// Orphans could only be written while `PRAGMA foreign_keys` was off, as it never was on before #184.
async function seedOrphans(db: ReturnType<typeof fresh>) {
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute(`
INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats, active_enrollment_id) VALUES (1, 'a', 'green', 'en', 'en', '{}', 10), (2, 'b', 'green', 'en', 'en', '{}', 99);
INSERT INTO enrollments(id, profile_id, course_iso, level) VALUES (10, 1, 'en', 'A1'), (30, 99, 'en', 'A1');
INSERT INTO step_progress(enrollment_id, step_id, state) VALUES (10, 's', 'done'), (99, 's', 'done');
INSERT INTO content_cache(enrollment_id, step_id, content) VALUES (10, 's', '{}'), (99, 's', '{}');
INSERT INTO mistakes(enrollment_id, item) VALUES (10, 'x'), (99, 'x');
INSERT INTO words(enrollment_id, word, translation) VALUES (10, 'w', 't'), (99, 'w', 't');
INSERT INTO bookmarks(enrollment_id, kind, ref) VALUES (10, 'unit', 'A1:greetings'), (99, 'unit', 'A1:greetings');
INSERT INTO unit_notes(enrollment_id, unit_ref, text) VALUES (10, 'A1:greetings', 'note'), (99, 'A1:greetings', 'note');
INSERT INTO journal(profile_id, day, text) VALUES (1, '2026-01-01', 'entry'), (99, '2026-01-01', 'entry');
INSERT INTO memories(profile_id, kind, text, source) VALUES (1, 'interest', 'x', 'tutor'), (99, 'interest', 'x', 'tutor');
INSERT INTO tutors(id, profile_id, data) VALUES ('custom:1', 1, '{}'), ('custom:99', 99, '{}');
INSERT INTO speech_sessions(profile_id, enrollment_id, mode, utterances, silences, wpm, pause_ratio, long_pauses, level, fillers, words, native_words, speech_ms) VALUES
  (1, 10, 'tutor', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000),
  (1, 99, 'tutor', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000),
  (99, 99, 'tutor', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000)`);
  await db.execute("PRAGMA foreign_keys = ON"); // the app opens the connection this way now
}

test("v11: drops rows whose parent is gone and keeps every valid row", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS.filter((m) => m.v < 11));
  await seedOrphans(db);

  await runMigrations(db, MIGRATIONS);
  assert.equal(await schemaVersion(db), Math.max(...MIGRATIONS.map((m) => m.v)));
  assert.deepEqual(await db.select("PRAGMA foreign_key_check"), [], "no constraint is left unsatisfied");

  assert.deepEqual(await db.select("SELECT id, active_enrollment_id FROM profiles"), [{ id: 1, active_enrollment_id: 10 }, { id: 2, active_enrollment_id: null }]);
  assert.deepEqual(await db.select("SELECT id FROM enrollments"), [{ id: 10 }]);
  for (const t of ["step_progress", "content_cache", "mistakes", "words", "bookmarks", "unit_notes"])
    assert.deepEqual(await db.select(`SELECT enrollment_id FROM ${t}`), [{ enrollment_id: 10 }], t);
  for (const t of ["journal", "memories", "tutors"])
    assert.deepEqual(await db.select(`SELECT profile_id FROM ${t}`), [{ profile_id: 1 }], t);
  assert.deepEqual(
    (await db.select<{ profile_id: number; enrollment_id: number | null }>("SELECT profile_id, enrollment_id FROM speech_sessions"))
      .map((s) => `${s.profile_id}:${s.enrollment_id ?? "null"}`)
      .sort(),
    ["1:10", "1:null"], // the NULL is the session whose enrollment was already gone
  );
});

test("v11: a v10 database with no orphans comes through untouched", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS.filter((m) => m.v < 11));
  // Written with foreign keys on (src/sqljs.ts), the way the app has written since #184.
  await db.execute(`
INSERT INTO device_settings(key, value) VALUES ('lang', 'en');
INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats, active_enrollment_id) VALUES (1, 'a', 'green', 'en', 'en', '{"streak":3}', 10);
INSERT INTO enrollments(id, profile_id, course_iso, level, xp) VALUES (10, 1, 'en', 'A1', 30);
INSERT INTO step_progress(enrollment_id, step_id, state, legendary) VALUES (10, 'A1:greetings', 'done', 1);
INSERT INTO content_cache(enrollment_id, step_id, content) VALUES (10, 'A1:greetings', '{}');
INSERT INTO mistakes(enrollment_id, item) VALUES (10, 'word:hello');
INSERT INTO words(enrollment_id, word, translation, strength) VALUES (10, 'hello', 'hola', 2);
INSERT INTO bookmarks(enrollment_id, kind, ref) VALUES (10, 'unit', 'A1:greetings');
INSERT INTO unit_notes(enrollment_id, unit_ref, text) VALUES (10, 'A1:greetings', 'note');
INSERT INTO journal(profile_id, day, text) VALUES (1, '2026-01-01', 'entry');
INSERT INTO memories(profile_id, kind, text, source) VALUES (1, 'interest', 'music', 'tutor');
INSERT INTO tutors(id, profile_id, data) VALUES ('custom:1', 1, '{}');
INSERT INTO ai_usage(provider, model, feature, input_tokens, output_tokens) VALUES ('openai', 'gpt-4o-mini', 'lesson', 10, 2);
INSERT INTO speech_sessions(profile_id, enrollment_id, mode, utterances, silences, wpm, pause_ratio, long_pauses, level, fillers, words, native_words, speech_ms) VALUES
  (1, 10, 'tutor', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000),
  (1, NULL, 'free', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000)`);
  const before = await snapshot(db);

  await runMigrations(db, MIGRATIONS);
  assert.deepEqual(await snapshot(db), before, "v11 removes nothing when every parent exists");
  assert.deepEqual(await db.select("PRAGMA foreign_key_check"), []);
});

test("v11: applying the cleanup twice is idempotent", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS.filter((m) => m.v < 11));
  await seedOrphans(db);
  const v11 = MIGRATIONS.find((m) => m.v === 11)!;

  await db.execute(v11.sql);
  const once = await snapshot(db);
  assert.deepEqual(await db.select("PRAGMA foreign_key_check"), []);

  await db.execute(v11.sql);
  assert.deepEqual(await snapshot(db), once, "the second pass finds nothing left to remove");
  assert.deepEqual(await db.select("PRAGMA foreign_key_check"), []);
});

test("runMigrations leaves foreign keys enforced", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS);
  const [pragma] = await db.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
  assert.equal(pragma.foreign_keys, 1);
});

test("v12: drops only the content_cache keys written before levels were part of them", async () => {
  const db = fresh();
  await runMigrations(db, MIGRATIONS.filter((m) => m.v < 12));
  await db.execute(`
INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats) VALUES (1, 'a', 'green', 'en', 'en', '{}');
INSERT INTO enrollments(id, profile_id, course_iso, level) VALUES (10, 1, 'en', 'A1')`);
  const legacy = ["story:greetings", "guide:greetings", "practice:greetings", "word:hello", "word:b1"];
  const kept = ["story:A1:greetings", "guide:B2:food", "practice:C1:society-and-environment", "word:A1:hello", "write:A1:greetings",
    "legend:greet-1", "garden:note", "A1:checkpoint", "greet-1", "storyline"];
  for (const k of [...legacy, ...kept])
    await db.execute("INSERT INTO content_cache(enrollment_id, step_id, content) VALUES (10, $1, '{}')", [k]);

  await runMigrations(db, MIGRATIONS);
  const left = (await db.select<{ step_id: string }>("SELECT step_id FROM content_cache")).map((r) => r.step_id).sort();
  assert.deepEqual(left, [...kept].sort());
});
