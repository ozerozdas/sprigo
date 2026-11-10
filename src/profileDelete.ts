// Profile deletion. Pure so it can be tested on sql.js without importing db.ts (which touches `window`).

/** One BEGIN…COMMIT script: the pooled plugin-sql connection needs the whole transaction in a single execute call. */
export function deleteProfileSql(id: number) {
  // The id is inlined (the script is multi-statement, so no bound params); an integer check keeps it injection-safe.
  if (!Number.isInteger(id)) throw new Error(`Invalid profile id: ${id}`);
  const mine = `SELECT id FROM enrollments WHERE profile_id = ${id}`;
  const byEnrollment = ["words", "mistakes", "content_cache", "step_progress", "bookmarks"].map((t) => `DELETE FROM ${t} WHERE enrollment_id IN (${mine});`);
  return ["BEGIN;", ...byEnrollment, `DELETE FROM enrollments WHERE profile_id = ${id};`, `DELETE FROM memories WHERE profile_id = ${id};`, `DELETE FROM speech_sessions WHERE profile_id = ${id};`, `DELETE FROM profiles WHERE id = ${id};`, "COMMIT;"].join("\n");
}
