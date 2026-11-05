import { test } from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { runMigrations } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { deleteProfileSql } from "./profileDelete.ts";
import { wrapSqlJs } from "./sqljs.ts";

const SQL = await initSqlJs();

async function seeded() {
  const db = wrapSqlJs(new SQL.Database());
  await runMigrations(db, MIGRATIONS);
  for (const p of [1, 2]) {
    await db.execute("INSERT INTO profiles(id, name, color, ui_lang, native_lang, stats) VALUES ($1, $2, '#000', 'en', 'en', '{}')", [p, `p${p}`]);
    const e = p * 10;
    await db.execute("INSERT INTO enrollments(id, profile_id, course_iso, level) VALUES ($1, $2, 'en', 'A1')", [e, p]);
    await db.execute("INSERT INTO step_progress(enrollment_id, step_id, state) VALUES ($1, 's', 'done')", [e]);
    await db.execute("INSERT INTO content_cache(enrollment_id, step_id, content) VALUES ($1, 's', '{}')", [e]);
    await db.execute("INSERT INTO mistakes(enrollment_id, item) VALUES ($1, 'x')", [e]);
    await db.execute("INSERT INTO words(enrollment_id, word, translation) VALUES ($1, 'w', 't')", [e]);
    await db.execute("INSERT INTO bookmarks(enrollment_id, kind, ref) VALUES ($1, 'unit', 'A1:greetings')", [e]);
    await db.execute("INSERT INTO memories(profile_id, kind, text, source) VALUES ($1, 'interest', 'x', 'tutor')", [p]);
    await db.execute("INSERT INTO speech_sessions(profile_id, mode, utterances, silences, wpm, pause_ratio, long_pauses, level, fillers, words, native_words, speech_ms) VALUES ($1, 'tutor', 1, 0, 90, 0.2, 0, 0.1, 0, 5, 0, 3000)", [p]);
  }
  return db;
}
const count = async (db: Awaited<ReturnType<typeof seeded>>, table: string) =>
  Number((await db.select<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0].n);

test("deleting a profile removes every row of it and keeps the others", async () => {
  const db = await seeded();
  await db.execute(deleteProfileSql(1));
  assert.deepEqual(await db.select("SELECT id FROM profiles"), [{ id: 2 }]);
  assert.deepEqual(await db.select("SELECT id FROM enrollments"), [{ id: 20 }]);
  for (const t of ["step_progress", "content_cache", "mistakes", "words", "bookmarks"]) {
    assert.deepEqual(await db.select(`SELECT enrollment_id FROM ${t}`), [{ enrollment_id: 20 }], t);
  }
  assert.deepEqual(await db.select("SELECT profile_id FROM memories"), [{ profile_id: 2 }]);
  assert.deepEqual(await db.select("SELECT profile_id FROM speech_sessions"), [{ profile_id: 2 }]);
});

test("deleting the last profile leaves the tables empty", async () => {
  const db = await seeded();
  await db.execute(deleteProfileSql(1));
  await db.execute(deleteProfileSql(2));
  for (const t of ["profiles", "enrollments", "step_progress", "content_cache", "mistakes", "words", "bookmarks", "memories", "speech_sessions"]) assert.equal(await count(db, t), 0, t);
});

test("the delete is one BEGIN/COMMIT block", () => {
  const sql = deleteProfileSql(3);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;$/);
});

test("a non-integer id is rejected before any SQL is built", () => {
  for (const bad of [1.5, NaN, "1; DROP TABLE profiles" as unknown as number]) assert.throws(() => deleteProfileSql(bad));
});
