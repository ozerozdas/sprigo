// OpenRouter sign-in (#197): OAuth PKCE in the system browser. Rust exchanges the code and saves the API key in the
// OS keychain (DECISIONS A6); the settings sheet reads it back like a pasted key.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { signInPayload, type Pkce } from "./oauthPayload";

/** ok: the key is saved. cancelled: the learner closed or denied. timeout: no answer in ten minutes. */
export type OpenRouterSignIn = "ok" | "cancelled" | "timeout";

// Tauri runs async commands on a thread pool, so two sign-ins may start in either order. The sequence number tells
// Rust which one the learner asked for last: a late-starting older attempt never supersedes a newer one.
let seq = 0;
const EPOCH = crypto.randomUUID(); // a reload restarts seq; Rust compares seq only within one epoch

export async function signInOpenRouter(p: Pkce): Promise<OpenRouterSignIn> {
  if (!isTauri) throw new Error("OpenRouter sign-in needs the desktop app");
  return invoke<OpenRouterSignIn>("openrouter_signin", signInPayload(p, ++seq, EPOCH));
}

/** Stops the sign-in started with this PKCE `state`, e.g. when its sheet closes. Never touches another attempt;
 *  harmless when that attempt already ended. */
export async function cancelOpenRouter(state: string): Promise<void> {
  if (isTauri) await invoke("openrouter_cancel", { state }).catch(() => {});
}
