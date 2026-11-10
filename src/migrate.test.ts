import { test } from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { FutureSchemaError, runMigrations, schemaVersion, type Migration } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { wrapSqlJs } from "./sqljs.ts";

const SQL = await initSqlJs();
const fresh = () => wrapSqlJs(new SQL.Database());
const tables = async (db: ReturnType<typeof fresh>) =>
  (await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);

const TABLES = ["bookmarks", "content_cache", "device_settings", "enrollments", "memories", "mistakes", "profiles", "speech_sessions", "step_progress", "words"];

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
