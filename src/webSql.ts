// Authenticated SQL transport for server-backed accounts in Sprigo Web.
import type { SqlDb } from "./migrate";

export const sharedWebMode = () => localStorage.getItem("sprigo.web.mode") === "account";
let seenRevision = 0;
export const noteSharedRevision = (revision: number) => { seenRevision = Math.max(seenRevision, revision || 0); };
export const seenSharedRevision = () => seenRevision;

export function accountDb(): SqlDb {
  const post = async <T,>(kind: "select" | "execute", sql: string, args: unknown[] = []): Promise<T> => {
    const response = await fetch("/account/sql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sprigo": "1" },
      body: JSON.stringify({ kind, sql, args }),
    });
    if (response.status === 401) { location.reload(); return new Promise<T>(() => {}); }
    if (!response.ok) throw new Error((await response.text()).slice(0, 300));
    const answer = await response.json();
    if (kind === "execute") noteSharedRevision(answer.revision);
    return answer as T;
  };
  return {
    select: (sql, args) => post("select", sql, args),
    execute: (sql, args) => post("execute", sql, args),
  };
}
