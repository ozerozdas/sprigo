// Ordered schema changes. Append only: never edit a shipped step, add a new one with the next `v`.
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
];
