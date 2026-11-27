// Data folder, lock and backups. Tauri only: the browser preview keeps its sql.js database.
// Rules in src/datarules.ts, file operations in src-tauri/src/data.rs.
import { invoke } from "@tauri-apps/api/core";
import type { SqlDb } from "./migrate";
import { backupsToPrune, dailyName, lockVerdict, sqliteUrl, sqlString, type Lock } from "./datarules";

export type Location = { dataDir: string; defaultDir: string; device: string };

/** The data folder isn't there (unplugged SSD, offline cloud folder). */
export class DataDirError extends Error {
  readonly dir: string;
  constructor(dir: string) { super(`Data folder unreachable: ${dir}`); this.name = "DataDirError"; this.dir = dir; }
}
/** Another device has the data open. */
export class LockedError extends Error {
  readonly device: string;
  constructor(device: string) { super(`Data is open on ${device}`); this.name = "LockedError"; this.device = device; }
}

let loc: Location | null = null;
export const dataLocation = async () => (loc ??= await invoke<Location>("data_location"));

// ponytail: "/" joins, the app ships for macOS (Windows accepts it too)
export const inDir = (dir: string, ...names: string[]) => [dir.replace(/[/\\]+$/, ""), ...names].join("/");
export const dbFile = (dir: string) => inDir(dir, "sprigo.db");

type TauriDb = SqlDb & { close(db?: string): Promise<boolean> };
let opened: TauriDb | null = null;

/** Folder → reachable → lock → open. Throws DataDirError / LockedError for the boot screen. */
export async function openTauriDb(): Promise<SqlDb> {
  const { dataDir, device } = await dataLocation();
  if (!(await invoke<boolean>("dir_ok", { dir: dataDir }))) throw new DataDirError(dataDir);
  const lock = await invoke<Lock | null>("lock_read", { dir: dataDir });
  if (lockVerdict(lock, device, Date.now()) === "held") throw new LockedError(lock!.device);
  await invoke("lock_write", { dir: dataDir }).catch(() => { throw new DataDirError(dataDir); });
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  opened = await Database.load(sqliteUrl(dbFile(dataDir)));
  await checkForeignKeys(opened);
  return opened;
}

/** tauri-plugin-sql has no connect hook and the URL takes no pragmas, so foreign keys rely on sqlx's default
 *  (SqliteConnectOptions::new sets foreign_keys=ON for every pooled connection, sqlx-sqlite 0.8.6). A single JS
 *  PRAGMA would only reach one pooled connection, so this checks instead of setting, and warns if a dependency
 *  update ever changes that default (#184: cascades and the v11 orphan cleanup assume enforcement). */
async function checkForeignKeys(d: SqlDb) {
  try {
    const [r] = await d.select<{ foreign_keys: number }>("PRAGMA foreign_keys");
    if (r?.foreign_keys !== 1) console.warn("SQLite foreign keys are OFF on the desktop database", r);
  } catch (e) { console.warn("Could not read PRAGMA foreign_keys", e); }
}

/** Consistent copy of the live database into `<dataDir>/backups/<name>` (VACUUM INTO works under WAL). Returns its path. */
export async function snapshot(d: SqlDb, name: string) {
  const { dataDir } = await dataLocation();
  await invoke("backups_list", { dir: dataDir }); // creates the folder
  const file = inDir(dataDir, "backups", name);
  await d.execute(`VACUUM INTO ${sqlString(file)}`);
  return file;
}

/** First open of the day: `backups/daily-YYYY-MM-DD.db`, keeping the last 7. */
export async function dailyBackup(d: SqlDb) {
  const { dataDir } = await dataLocation();
  const names = await invoke<string[]>("backups_list", { dir: dataDir });
  const name = dailyName();
  // ponytail: only on open; an app left running in the background for days backs up again on its next start
  if (!names.includes(name)) { await snapshot(d, name); names.push(name); }
  for (const n of backupsToPrune(names)) await invoke("backups_remove", { dir: dataDir, name: n });
}

let beat: number | undefined;
/** Refreshes the lock every minute. If another device took it over meanwhile, stops and reports it. */
export function startHeartbeat(onLost: (device: string) => void) {
  clearInterval(beat);
  beat = window.setInterval(async () => {
    const { dataDir, device } = await dataLocation();
    const lock = await invoke<Lock | null>("lock_read", { dir: dataDir }).catch(() => null);
    if (lock && lock.device !== device) { clearInterval(beat); onLost(lock.device); return; }
    invoke("lock_write", { dir: dataDir }).catch((e) => console.error("lock", e));
  }, 60_000);
}

/** Boot screen "Take over": claim the lock, then start again. */
export async function takeOver() {
  await invoke("lock_write", { dir: (await dataLocation()).dataDir });
  location.reload();
}
/** Boot screen "Use the default folder". */
export async function resetDataDir() {
  await invoke("set_data_dir", { dir: null });
  location.reload();
}

/** Before the database file is replaced: stops the heartbeat and closes the pool (checkpoints the WAL). Restart next. */
export async function closeTauriDb() {
  clearInterval(beat);
  await opened?.close().catch((e) => console.error("close", e));
}

/** Releases the lock and restarts the app (after the database file or folder changed). */
export async function restart() {
  clearInterval(beat);
  await invoke("lock_remove", { dir: (await dataLocation()).dataDir }).catch(() => {});
  await (await import("@tauri-apps/plugin-process")).relaunch();
}

/** Lock state of another folder, before switching to it. */
export async function lockHolder(dir: string) {
  const lock = await invoke<Lock | null>("lock_read", { dir });
  return lockVerdict(lock, (await dataLocation()).device, Date.now()) === "held" ? lock!.device : null;
}
