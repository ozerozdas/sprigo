// SQLite storage (DECISIONS A5, E4–E6). In Tauri: tauri-plugin-sql, `sprigo.db` in the data folder (src/datadir.ts).
// Schema changes live in src/migrations.ts and run on open.
// ponytail: in a plain browser (the Vite preview used during development) the same SQL runs on sql.js,
// persisted to localStorage. Never used in the shipped app.
import type { Cefr } from "./course";
import type { ThemePref } from "./theme";
import { NEW_STATS, type Stats } from "./progress";
import { runMigrations, type SqlDb } from "./migrate";
import { MIGRATIONS } from "./migrations";
import { wrapSqlJs } from "./sqljs";
import { dailyBackup, openTauriDb, snapshot } from "./datadir";
import { deleteProfileSql } from "./profileDelete";
import type { Baseline, Conditions, SessionRow, SpeechSummary } from "./speech";
import { remoteDb, serveCompanion } from "./companion";
import { evictIds, type Memory, type MemoryOps, type MemorySource } from "./memory";
import { grade, newCard, review, strengthOf, type Grade, type WordCard } from "./srs";
import { USAGE_SQL, type AiFeature, type UsageRow } from "./usage";
export { NEW_STATS, type Stats };

type Row = Record<string, any>;
type Db = SqlDb;

async function browserDb(): Promise<Db> {
  const [{ default: init }, { default: wasm }] = await Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]);
  const SQL = await init({ locateFile: () => wasm });
  const KEY = "sprigo.devdb";
  const saved = localStorage.getItem(KEY);
  const db = new SQL.Database(saved ? Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)) : undefined);
  // Chunked: spreading the whole export into fromCharCode overflows the stack once the database passes ~100 KB.
  const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  return wrapSqlJs(db, () => localStorage.setItem(KEY, b64(db.export())));
}

let dbP: Promise<Db> | null = null;
export const isTauri = "__TAURI_INTERNALS__" in window;
/** Opened from a phone through `tailscale serve` (docs/MOBILE.md): data, whisper and Ollama are the desktop's. */
export const isCompanion = !isTauri && location.hostname.endsWith(".ts.net");
function db() {
  return (dbP ??= (async () => {
    if (isCompanion) return remoteDb(); // the desktop already migrated it
    const d = await (isTauri ? openTauriDb() : import.meta.env.DEV ? browserDb() : Promise.reject(new Error("Sprigo needs the Tauri shell")));
    await runMigrations(d, MIGRATIONS, isTauri ? (v) => snapshot(d, `pre-v${v}-${Date.now()}.db`).then(() => {}) : undefined);
    if (isTauri) await dailyBackup(d).catch((e) => console.error("daily backup", e));
    if (isTauri) void serveCompanion(d).catch((e) => console.error("companion", e));
    return d;
  })());
}

/** Opens (and migrates) the database now; the boot sequence calls this first so folder/lock errors surface there. */
export const openDb = () => db().then(() => {});
/** Tauri: consistent copy of the live database into `<dataDir>/backups/<name>`, returns its path. */
export const backupNow = async (name: string) => snapshot(await db(), name);

// ---- Types ----

export type Profile = {
  id: number; name: string; color: string; pin_hash: string | null; ui_lang: string; theme: ThemePref;
  native_lang: string; active_enrollment_id: number | null; stats: Stats; created_at: string;
};
export type Enrollment = { id: number; profile_id: number; course_iso: string; level: Cefr; xp: number };

const toProfile = (r: Row): Profile => ({ ...(r as Profile), stats: { ...NEW_STATS, ...JSON.parse(r.stats) } });

// ---- Device ----

export async function getSetting(key: string) {
  const r = await (await db()).select<{ value: string }>("SELECT value FROM device_settings WHERE key = $1", [key]);
  return r[0]?.value ?? null;
}
export async function setSetting(key: string, value: string | null) {
  await (await db()).execute("INSERT INTO device_settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2", [key, value]);
}

// ---- Profiles ----

export async function listProfiles() {
  return (await (await db()).select("SELECT * FROM profiles ORDER BY id")).map(toProfile);
}
export async function getProfile(id: number) {
  const r = await (await db()).select("SELECT * FROM profiles WHERE id = $1", [id]);
  return r[0] ? toProfile(r[0]) : null;
}

export type NewProfile = Pick<Profile, "name" | "color" | "ui_lang" | "theme" | "native_lang"> & { pin: string | null };
export async function createProfile(p: NewProfile, courseIso: string, level: Cefr) {
  const d = await db();
  const { lastInsertId: id } = await d.execute(
    "INSERT INTO profiles(name, color, pin_hash, ui_lang, theme, native_lang, stats) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [p.name, p.color, p.pin ? await hashPin(p.pin) : null, p.ui_lang, p.theme, p.native_lang, JSON.stringify(NEW_STATS)],
  );
  await enroll(id!, courseIso, level);
  return id!;
}

type ProfilePatch = Partial<Pick<Profile, "name" | "color" | "ui_lang" | "theme" | "native_lang" | "active_enrollment_id" | "stats">> & { pin?: string | null };
export async function updateProfile(id: number, patch: ProfilePatch) {
  const { pin, stats, ...rest } = patch;
  const cols: Record<string, unknown> = { ...rest };
  if (stats) cols.stats = JSON.stringify(stats);
  if (pin !== undefined) cols.pin_hash = pin ? await hashPin(pin) : null;
  const keys = Object.keys(cols); // keys come from the typed patch above, never from user input
  if (!keys.length) return;
  await (await db()).execute(
    `UPDATE profiles SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE id = $${keys.length + 1}`,
    [...Object.values(cols), id],
  );
}

/** Removes the profile and all its progress in one transaction; forgets it as the auto-sign-in profile. */
export async function deleteProfile(id: number) {
  const d = await db();
  try { await d.execute(deleteProfileSql(id)); }
  catch (e) { await d.execute("ROLLBACK").catch(() => {}); throw e; }
  if (Number(await getSetting("last_profile")) === id) await setSetting("last_profile", null);
}

// ---- Enrollments (profile × course) ----

export async function listEnrollments(profileId: number) {
  return (await db()).select<Enrollment>("SELECT id, profile_id, course_iso, level, xp FROM enrollments WHERE profile_id = $1 ORDER BY id", [profileId]);
}
/** Enrolls (or reuses the existing enrollment) and makes it the profile's active course. */
export async function enroll(profileId: number, courseIso: string, level: Cefr) {
  const d = await db();
  await d.execute("INSERT INTO enrollments(profile_id, course_iso, level) VALUES ($1, $2, $3) ON CONFLICT(profile_id, course_iso) DO NOTHING", [profileId, courseIso, level]);
  const [{ id }] = await d.select<{ id: number }>("SELECT id FROM enrollments WHERE profile_id = $1 AND course_iso = $2", [profileId, courseIso]);
  await updateProfile(profileId, { active_enrollment_id: id });
  return id;
}
export async function addXp(enrollmentId: number, xp: number) {
  await (await db()).execute("UPDATE enrollments SET xp = xp + $1 WHERE id = $2", [xp, enrollmentId]);
}

// ---- Progress ----

export async function doneSteps(enrollmentId: number) {
  const r = await (await db()).select<{ step_id: string }>("SELECT step_id FROM step_progress WHERE enrollment_id = $1 AND state = 'done'", [enrollmentId]);
  return new Set(r.map((x) => x.step_id));
}
export async function legendarySteps(enrollmentId: number) {
  const r = await (await db()).select<{ step_id: string }>("SELECT step_id FROM step_progress WHERE enrollment_id = $1 AND legendary = 1", [enrollmentId]);
  return new Set(r.map((x) => x.step_id));
}
export async function markLegendary(enrollmentId: number, stepId: string) {
  await (await db()).execute("UPDATE step_progress SET legendary = 1 WHERE enrollment_id = $1 AND step_id = $2", [enrollmentId, stepId]);
}
export async function markDone(enrollmentId: number, stepId: string) {
  await (await db()).execute("INSERT INTO step_progress(enrollment_id, step_id, state) VALUES ($1, $2, 'done') ON CONFLICT DO UPDATE SET state = 'done'", [enrollmentId, stepId]);
}

// ---- Bookmarks (#45; per enrollment, targets resolved against the course at render time) ----

export type BookmarkKind = "unit" | "guide" | "story";
export type Bookmark = { kind: BookmarkKind; ref: string };

export async function listBookmarks(enrollmentId: number) {
  return (await db()).select<Bookmark>("SELECT kind, ref FROM bookmarks WHERE enrollment_id = $1 ORDER BY created_at DESC, kind, ref", [enrollmentId]);
}
export async function isBookmarked(enrollmentId: number, kind: BookmarkKind, ref: string) {
  return (await (await db()).select("SELECT 1 FROM bookmarks WHERE enrollment_id = $1 AND kind = $2 AND ref = $3", [enrollmentId, kind, ref])).length > 0;
}
/** Saves or removes the bookmark; returns its new state. */
export async function toggleBookmark(enrollmentId: number, kind: BookmarkKind, ref: string) {
  const d = await db();
  if (await isBookmarked(enrollmentId, kind, ref)) {
    await d.execute("DELETE FROM bookmarks WHERE enrollment_id = $1 AND kind = $2 AND ref = $3", [enrollmentId, kind, ref]);
    return false;
  }
  await d.execute("INSERT INTO bookmarks(enrollment_id, kind, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [enrollmentId, kind, ref]);
  return true;
}

// ---- AI usage (#48; global like the AI config, cost is estimated in src/usage.ts) ----

export async function addAiUsage(provider: string, model: string, feature: AiFeature, input: number, output: number) {
  await (await db()).execute("INSERT INTO ai_usage(provider, model, feature, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5)", [provider, model, feature, input, output]);
}
/** Local months that have usage, newest first. */
export async function aiUsageMonths() {
  const r = await (await db()).select<{ month: string }>("SELECT DISTINCT strftime('%Y-%m', created_at, 'localtime') AS month FROM ai_usage ORDER BY month DESC");
  return r.map((x) => x.month);
}
/** Usage grouped by month, feature, provider and model. */
export async function aiUsage() {
  return (await db()).select<UsageRow>(USAGE_SQL);
}

// ---- Generated lesson cache (DECISIONS C3; per enrollment because it will be personalised by mistakes) ----

export async function getCached<T>(enrollmentId: number, stepId: string): Promise<T | null> {
  const r = await (await db()).select<{ content: string }>("SELECT content FROM content_cache WHERE enrollment_id = $1 AND step_id = $2", [enrollmentId, stepId]);
  return r[0] ? JSON.parse(r[0].content) : null;
}
export async function putCached(enrollmentId: number, stepId: string, content: unknown) {
  await (await db()).execute("INSERT INTO content_cache(enrollment_id, step_id, content) VALUES ($1, $2, $3) ON CONFLICT DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP", [enrollmentId, stepId, JSON.stringify(content)]);
}

/** Every cached unit guidebook (`guide:<unit>`), for word lookups (#28). */
export async function cachedGuides<T>(enrollmentId: number) {
  const r = await (await db()).select<{ content: string }>("SELECT content FROM content_cache WHERE enrollment_id = $1 AND step_id LIKE 'guide:%'", [enrollmentId]);
  return r.map((x) => JSON.parse(x.content) as T);
}

/** Levels passed via checkpoint or level test: marks every node of the level done and moves the enrollment on. */
export async function completeLevel(enrollmentId: number, ids: string[], next: Cefr | null) {
  for (const id of ids) await markDone(enrollmentId, id);
  if (next) await (await db()).execute("UPDATE enrollments SET level = $1 WHERE id = $2", [next, enrollmentId]);
}

/** Scored items of every cached step lesson (not legend/story/guide/exam keys, which contain ":"), for the timed challenge. */
export async function cachedLessonItems<T extends { kind: string }>(enrollmentId: number) {
  const r = await (await db()).select<{ content: string }>("SELECT content FROM content_cache WHERE enrollment_id = $1 AND step_id NOT LIKE '%:%'", [enrollmentId]);
  return r.flatMap((x) => JSON.parse(x.content) as T[]).filter((it) => it.kind !== "learn");
}

// ---- Mistakes and words (per enrollment, DECISIONS E6) ----

export async function addMistake(enrollmentId: number, item: unknown) {
  await (await db()).execute("INSERT INTO mistakes(enrollment_id, item) VALUES ($1, $2) ON CONFLICT DO NOTHING", [enrollmentId, JSON.stringify(item)]);
}
export async function listMistakes<T>(enrollmentId: number, limit = 1000) {
  const r = await (await db()).select<{ id: number; item: string }>("SELECT id, item FROM mistakes WHERE enrollment_id = $1 ORDER BY id DESC LIMIT $2", [enrollmentId, limit]);
  return r.map((x) => ({ id: x.id, item: JSON.parse(x.item) as T }));
}
export async function deleteMistake(id: number) {
  await (await db()).execute("DELETE FROM mistakes WHERE id = $1", [id]);
}
/** Removes the row `addMistake` wrote for this item (F: accepted appeal). */
export async function deleteMistakeByItem(enrollmentId: number, item: unknown) {
  await (await db()).execute("DELETE FROM mistakes WHERE enrollment_id = $1 AND item = $2", [enrollmentId, JSON.stringify(item)]);
}

export type Word = { word: string; translation: string; strength: number; card: WordCard };
const CARD_COLS = "due, stability, difficulty, reps, lapses, state, last_review";
/** New words start as FSRS New cards. Seeing a word again only refreshes its translation: only recall is graded (#20). */
export async function addWords(enrollmentId: number, pairs: [string, string][]) {
  known = null;
  const d = await db(), c = newCard(new Date());
  for (const [w, t] of pairs) await d.execute(
    `INSERT INTO words(enrollment_id, word, translation, ${CARD_COLS}, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
     ON CONFLICT DO UPDATE SET translation = $3, updated_at = CURRENT_TIMESTAMP`,
    [enrollmentId, w, t, c.due, c.stability, c.difficulty, c.reps, c.lapses, c.state, c.last_review]);
}
/** One recall of `word`: right → Good, wrong → Again, or a flashcard's own grade (src/srs.ts). */
export async function reviewWord(enrollmentId: number, word: string, ok: boolean | Grade) {
  const d = await db();
  const [row] = await d.select<WordCard>(`SELECT ${CARD_COLS} FROM words WHERE enrollment_id = $1 AND word = $2`, [enrollmentId, word]);
  if (!row) return;
  const c = typeof ok === "boolean" ? review(row, ok, new Date()) : grade(row, ok, new Date());
  await d.execute(
    "UPDATE words SET due = $1, stability = $2, difficulty = $3, reps = $4, lapses = $5, state = $6, last_review = $7, updated_at = CURRENT_TIMESTAMP WHERE enrollment_id = $8 AND word = $9",
    [c.due, c.stability, c.difficulty, c.reps, c.lapses, c.state, c.last_review, enrollmentId, word]);
}
/** Imported words (#24): new ones take the file's schedule (or start New), existing ones only get the file's translation. */
export async function importWords(enrollmentId: number, words: { word: string; translation: string; card?: WordCard }[]) {
  known = null;
  const d = await db(), c = newCard(new Date());
  const had = new Set((await d.select<{ word: string }>("SELECT word FROM words WHERE enrollment_id = $1", [enrollmentId])).map((r) => r.word));
  for (const { word, translation, card = c } of words) await d.execute(
    `INSERT INTO words(enrollment_id, word, translation, ${CARD_COLS}, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
     ON CONFLICT DO UPDATE SET translation = $3, updated_at = CURRENT_TIMESTAMP`,
    [enrollmentId, word, translation, card.due, card.stability, card.difficulty, card.reps, card.lapses, card.state, card.last_review]);
  const added = words.filter((w) => !had.has(w.word)).length;
  return { added, updated: words.length - added };
}
/** New words per local day (YYYY-MM-DD), for the progress chart (#31). */
export async function wordDays(enrollmentId: number) {
  const r = await (await db()).select<{ d: string; n: number }>(
    "SELECT date(created_at, 'localtime') AS d, COUNT(*) AS n FROM words WHERE enrollment_id = $1 GROUP BY d", [enrollmentId]);
  return Object.fromEntries(r.map((x) => [x.d, x.n]));
}
// The list's words, for highlighting them in text (#27). Kept until the list changes.
// ponytail: only addWords/importWords clear it; clear on profile delete too if enrollment ids get reused
let known: { id: number; words: Promise<string[]> } | null = null;
export function knownWords(enrollmentId: number) {
  if (known?.id !== enrollmentId) known = { id: enrollmentId, words: listWords(enrollmentId).then((ws) => ws.map((w) => w.word)) };
  return known.words;
}

export async function listWords(enrollmentId: number): Promise<Word[]> {
  const rows = await (await db()).select<{ word: string; translation: string } & WordCard>(
    `SELECT word, translation, ${CARD_COLS} FROM words WHERE enrollment_id = $1 ORDER BY updated_at DESC, word`, [enrollmentId]);
  return rows.map(({ word, translation, ...card }) => ({ word, translation, strength: strengthOf(card), card }));
}

// ---- Profile memory (SPR-22, src/memory.ts; per profile, shared by its courses) ----

/** The profile's own switch (Stats.memoryOn, on for new and older profiles). */
export const memoryOn = async (profileId: number) => (await getProfile(profileId))?.stats.memoryOn ?? false;
export async function listMemories(profileId: number) {
  return (await db()).select<Memory>("SELECT id, kind, text, source, hits, last_seen_at FROM memories WHERE profile_id = $1 ORDER BY id", [profileId]);
}
export async function updateMemory(id: number, text: string) {
  await (await db()).execute("UPDATE memories SET text = $1, last_seen_at = CURRENT_TIMESTAMP WHERE id = $2", [text, id]);
}
export async function deleteMemory(id: number) {
  await (await db()).execute("DELETE FROM memories WHERE id = $1", [id]);
}
export async function forgetMemories(profileId: number) {
  await (await db()).execute("DELETE FROM memories WHERE profile_id = $1", [profileId]);
}
export async function markMemoriesUsed(ids: number[]) {
  if (ids.length) await (await db()).execute(`UPDATE memories SET hits = hits + 1 WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})`, ids);
}
export async function enrollmentProfile(enrollmentId: number) {
  const r = await (await db()).select<{ profile_id: number }>("SELECT profile_id FROM enrollments WHERE id = $1", [enrollmentId]);
  return r[0]?.profile_id ?? null;
}
/** Applies cleaned ops (cleanOps), then drops the least used past MEMORY_MAX. */
export async function applyMemoryOps(profileId: number, source: MemorySource, ops: MemoryOps) {
  const d = await db();
  for (const id of ops.forget) await d.execute("DELETE FROM memories WHERE id = $1 AND profile_id = $2", [id, profileId]);
  for (const u of ops.update) await d.execute("UPDATE memories SET text = $1, last_seen_at = CURRENT_TIMESTAMP WHERE id = $2 AND profile_id = $3", [u.text, u.id, profileId]);
  for (const a of ops.add) await d.execute("INSERT INTO memories(profile_id, kind, text, source) VALUES ($1, $2, $3, $4)", [profileId, a.kind, a.text, source]);
  for (const id of evictIds(await listMemories(profileId))) await d.execute("DELETE FROM memories WHERE id = $1", [id]);
}

// ---- Speech signals (SPR-25, src/speech.ts) ----

export async function saveSpeechSession(profileId: number, enrollmentId: number | null, x: SpeechSummary, conditions: Conditions | null, avoided: string | null = null) {
  await (await db()).execute(
    `INSERT INTO speech_sessions(profile_id, enrollment_id, mode, utterances, silences, latency_ms, wpm, pause_ratio, long_pauses, level, fillers, words, native_words, speech_ms, conditions, avoided)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [profileId, enrollmentId, conditions?.mode ?? "chat", x.utterances, x.silences, x.latencyMs, x.wpm, x.pauseRatio, x.longPauses, x.level, x.fillers, x.words, x.nativeWords, x.speechMs,
      conditions && JSON.stringify(conditions), avoided]);
}

/** The last `limit` voice sessions, oldest first: the coaching card (SPR-27, tutor calls only) and the drills (every mode) read them. */
export async function listSpeechSessions(profileId: number, limit = 10, mode?: Conditions["mode"]): Promise<SessionRow[]> {
  const rows = await (await db()).select<SessionRow & { conditions: string | null }>(
    `SELECT utterances, latency_ms, wpm, long_pauses, words, native_words, mode, conditions, avoided FROM speech_sessions WHERE profile_id = $1${mode ? " AND mode = $3" : ""} ORDER BY id DESC LIMIT $2`,
    mode ? [profileId, limit, mode] : [profileId, limit]);
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) as Conditions : null; } catch { return null; } }; // a broken row counts as not measured
  return rows.map((r) => ({ ...r, conditions: parse(r.conditions) })).reverse();
}
/** Average speaking pace per week (Monday, local YYYY-MM-DD) over every voice mode, for the progress chart (#31). */
export async function speechWeeks(profileId: number) {
  const r = await (await db()).select<{ w: string; wpm: number }>(
    `SELECT date(created_at, 'localtime', '-6 days', 'weekday 1') AS w, ROUND(AVG(wpm)) AS wpm FROM speech_sessions
     WHERE profile_id = $1 AND words > 0 GROUP BY w`, [profileId]);
  return Object.fromEntries(r.map((x) => [x.w, x.wpm]));
}
/** The learner's usual per answer over their last 10 tutor calls (SPR-26); chats and drills are a different kind of talk. Null before they have said a few things. */
export async function speechBaseline(profileId: number): Promise<Baseline | null> {
  const [r] = await (await db()).select<Baseline & { n: number | null }>(
    `SELECT SUM(utterances) AS n, AVG(latency_ms) AS latencyMs, SUM(wpm * utterances) * 1.0 / SUM(utterances) AS wpm,
       SUM(pause_ratio * utterances) / SUM(utterances) AS pauseRatio, SUM(words) * 1.0 / SUM(utterances) AS words
     FROM (SELECT * FROM speech_sessions WHERE profile_id = $1 AND mode = 'tutor' AND utterances > 0 ORDER BY id DESC LIMIT 10)`, [profileId]);
  return r && (r.n ?? 0) >= 3 ? { latencyMs: r.latencyMs, wpm: r.wpm, pauseRatio: r.pauseRatio, words: r.words } : null;
}

// ---- PIN (DECISIONS E4: a privacy lock between people sharing a device, not real security) ----

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha(salt: string, pin: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + pin)));
}
async function hashPin(pin: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `${salt}:${await sha(salt, pin)}`;
}
export async function checkPin(p: Profile, pin: string) {
  if (!p.pin_hash) return true;
  const [salt, h] = p.pin_hash.split(":");
  return (await sha(salt, pin)) === h;
}
