// Ordered schema changes. Append only: never edit a shipped step, add a new one with the next `v`.
// Foreign keys are enforced on every connection: sqlx turns them on by default (desktop, tauri-plugin-sql) and
// src/sqljs.ts does the same (dev preview, web edition, tests). A step that rebuilds a table (CREATE new / copy /
// DROP old / RENAME) must therefore run `PRAGMA foreign_keys = OFF` before BEGIN — it is ignored inside a
// transaction — or the DROP fails and/or the copy cascades rows away. runMigrations wraps each step in a
// transaction (src/migrate.ts), so such a step needs runner support before it can be written.
import type { Migration } from "./migrate";

export const MIGRATIONS: Migration[] = [
  {
    v: 1, // the 0.1.x schema; IF NOT EXISTS so existing databases pass through untouched
    sql: `
CREATE TABLE IF NOT EXISTS device_settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS profiles(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, pin_hash TEXT,
  ui_lang TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'system', native_lang TEXT NOT NULL,
  active_enrollment_id INTEGER, stats TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS enrollments(
  id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_iso TEXT NOT NULL, level TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(profile_id, course_iso));
CREATE TABLE IF NOT EXISTS step_progress(
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE, step_id TEXT NOT NULL,
  state TEXT NOT NULL, legendary INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(enrollment_id, step_id));
CREATE TABLE IF NOT EXISTS content_cache(
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE, step_id TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(enrollment_id, step_id));
CREATE TABLE IF NOT EXISTS mistakes(
  id INTEGER PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  item TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(enrollment_id, item));
CREATE TABLE IF NOT EXISTS words(
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE, word TEXT NOT NULL, translation TEXT NOT NULL,
  strength INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(enrollment_id, word))`,
  },
  {
    v: 2, // SPR-22: profile memory, facts about the learner (src/memory.ts)
    sql: `
CREATE TABLE memories(
  id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX memories_profile ON memories(profile_id)`,
  },
  {
    v: 3, // SPR-25: speech signals, one summary row per voice session (src/speech.ts); no audio is kept
    sql: `
CREATE TABLE speech_sessions(
  id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL, mode TEXT NOT NULL,
  utterances INTEGER NOT NULL, silences INTEGER NOT NULL, latency_ms INTEGER, wpm INTEGER NOT NULL,
  pause_ratio REAL NOT NULL, long_pauses INTEGER NOT NULL, level REAL NOT NULL, fillers INTEGER NOT NULL,
  words INTEGER NOT NULL, native_words INTEGER NOT NULL, speech_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX speech_sessions_profile ON speech_sessions(profile_id)`,
  },
  {
    v: 4, // fluency drills: the conditions a voice session was spoken under (JSON Conditions, src/speech.ts; NULL = not measured)
    // and the target structure the learner avoided in it (structure drill)
    sql: `ALTER TABLE speech_sessions ADD COLUMN conditions TEXT;
ALTER TABLE speech_sessions ADD COLUMN avoided TEXT`,
  },
  {
    v: 5, // #20: FSRS state per word (src/srs.ts), seeded from the old 0–5 strength so progress carries over.
    // `due` has no default: ALTER TABLE only takes constant defaults, so addWords writes it. `strength` stays, unused.
    sql: `ALTER TABLE words ADD COLUMN due TEXT;
ALTER TABLE words ADD COLUMN stability REAL NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN difficulty REAL NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN last_review TEXT;
UPDATE words SET
  state = CASE WHEN strength >= 2 THEN 2 ELSE 0 END,
  stability = CASE WHEN strength >= 5 THEN 15 WHEN strength = 4 THEN 7 WHEN strength = 3 THEN 3 WHEN strength = 2 THEN 1 ELSE 0 END,
  difficulty = CASE WHEN strength >= 2 THEN 5 ELSE 0 END,
  reps = CASE WHEN strength >= 2 THEN MIN(strength, 5) - 1 ELSE 0 END,
  last_review = CASE WHEN strength >= 2 THEN updated_at END,
  due = CASE WHEN strength >= 5 THEN datetime(updated_at, '+15 days') WHEN strength = 4 THEN datetime(updated_at, '+7 days')
    WHEN strength = 3 THEN datetime(updated_at, '+3 days') WHEN strength = 2 THEN datetime(updated_at, '+1 day') ELSE CURRENT_TIMESTAMP END`,
  },
  {
    v: 6, // #31: when a word was added, for the words-over-time chart. Older words get their best guess (first review or last change).
    sql: `ALTER TABLE words ADD COLUMN created_at TEXT;
UPDATE words SET created_at = COALESCE(last_review, updated_at)`,
  },
  {
    v: 7, // #45: saved units, guidebooks and stories. Kind is "unit" | "guide" | "story"; ref is the target id (a unit ref carries its level).
    sql: `
CREATE TABLE bookmarks(
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(enrollment_id, kind, ref))`,
  },
  {
    v: 8, // #48: tokens per AI call and feature, for the estimated cost in Settings. Global like the AI config (E6), so no profile.
    sql: `
CREATE TABLE ai_usage(
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, feature TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ai_usage_created ON ai_usage(created_at)`,
  },
  {
    v: 9, // #167: custom tutors, per profile like memories (src/tutors.ts). `data` is the package without the images,
    // which get their own columns; `source` is "local" | "imported" (imported tutors get no memory writes later).
    sql: `
CREATE TABLE tutors(
  id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  data TEXT NOT NULL, avatar TEXT, scene TEXT, source TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX tutors_profile ON tutors(profile_id)`,
  },
  {
    v: 10, // #46: the learner's own writing. `unit_notes` is one note per unit of an enrollment (`level:unit`, src/course.ts unitRef);
    // `journal` is one entry per local day (YYYY-MM-DD, src/progress.ts today). Both are part of the database, so export and backups carry them.
    // The REFERENCES clauses cascade: sqlx turns `PRAGMA foreign_keys` on for every connection (the desktop app), and
    // src/sqljs.ts does the same (dev preview, web edition, tests). src/profileDelete.ts still deletes explicitly.
    sql: `
CREATE TABLE unit_notes(
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  unit_ref TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(enrollment_id, unit_ref));
CREATE TABLE journal(
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(profile_id, day))`,
  },
  {
    v: 11, // #184: foreign keys are enforced from now on, so rows left behind while `PRAGMA foreign_keys` was off (their
    // parent deleted) would never cascade. Remove them once, the way their REFERENCES clause would have: everything
    // deletes, speech_sessions.enrollment_id is set to NULL. profiles.active_enrollment_id has no REFERENCES, so it is
    // nulled by hand. Deleting orphan enrollments already NULLs their speech_sessions (ON DELETE SET NULL); the
    // UPDATE below catches sessions whose enrollment never existed at all.
    sql: `
DELETE FROM enrollments WHERE profile_id NOT IN (SELECT id FROM profiles);
DELETE FROM step_progress WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM content_cache WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM mistakes WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM words WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM bookmarks WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM unit_notes WHERE enrollment_id NOT IN (SELECT id FROM enrollments);
DELETE FROM memories WHERE profile_id NOT IN (SELECT id FROM profiles);
DELETE FROM journal WHERE profile_id NOT IN (SELECT id FROM profiles);
DELETE FROM tutors WHERE profile_id NOT IN (SELECT id FROM profiles);
DELETE FROM speech_sessions WHERE profile_id NOT IN (SELECT id FROM profiles);
UPDATE speech_sessions SET enrollment_id = NULL WHERE enrollment_id IS NOT NULL AND enrollment_id NOT IN (SELECT id FROM enrollments);
UPDATE profiles SET active_enrollment_id = NULL WHERE active_enrollment_id IS NOT NULL AND active_enrollment_id NOT IN (SELECT id FROM enrollments)`,
  },
  {
    v: 12, // Generated content keyed before levels were part of the key (stories/guides before 1.9 and #183, practice and
    // word lookups before #192) is never read again: readers use `<kind>:<level>:…` (src/course.ts, src/practice.ts,
    // src/lookup.ts). Drop those rows. GLOB is case-sensitive, and old word keys are lowercased, so a word cannot
    // look like a level. `write:`, `legend:`, `garden:note`, exam ids (`A1:checkpoint`) and plain step ids stay.
    sql: `
DELETE FROM content_cache WHERE
     (step_id GLOB 'story:*'    AND step_id NOT GLOB 'story:[ABC][12]:*')
  OR (step_id GLOB 'guide:*'    AND step_id NOT GLOB 'guide:[ABC][12]:*')
  OR (step_id GLOB 'practice:*' AND step_id NOT GLOB 'practice:[ABC][12]:*')
  OR (step_id GLOB 'word:*'     AND step_id NOT GLOB 'word:[ABC][12]:*')`,
  },
];
