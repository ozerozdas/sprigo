// Optional server account for the standalone web edition. Local browser profiles stay available.
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isWeb } from "./db";
import { noteSharedRevision, seenSharedRevision } from "./webSql";

export type WebMode = "local" | "account";
const KEY = "sprigo.web.mode";
const mode = (): WebMode => localStorage.getItem(KEY) === "account" ? "account" : "local";
const choose = (next: WebMode) => { localStorage.setItem(KEY, next); location.reload(); };

const C = createContext<{ mode: WebMode; account: string | null; useLocal: () => void; useAccount: () => void; signOut: () => Promise<void> }>({
  mode: "local", account: null, useLocal: () => {}, useAccount: () => {}, signOut: async () => {},
});
export const useWebAccess = () => useContext(C);

async function post(path: string, payload: object) {
  const response = await fetch(`/account/${path}`, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Sprigo": "1" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 300));
}

/** Reads an existing local Sprigo database without changing or deleting it. */
async function localDatabase(): Promise<ArrayBuffer | null> {
  const opened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("sprigo-web", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let saved: ArrayBuffer | null;
  try {
    saved = await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const request = opened.transaction("state", "readonly").objectStore("state").get("db");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { opened.close(); }
  if (!saved) return null;
  // A freshly opened browser already has an empty SQLite database; offer import only when it has profiles.
  const [{ default: init }, { default: wasm }] = await Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]);
  const SQL = await init({ locateFile: () => wasm });
  const database = new SQL.Database(new Uint8Array(saved));
  try { return Number(database.exec("SELECT count(*) FROM profiles")[0]?.values[0]?.[0] ?? 0) > 0 ? saved : null; }
  finally { database.close(); }
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 0x8000) encoded += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(encoded);
}

function AccountGate() {
  const { t } = useTranslation();
  const [create, setCreate] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordless, setPasswordless] = useState(false);
  const [copy, setCopy] = useState(true);
  const [local, setLocal] = useState<ArrayBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { localDatabase().then(setLocal).catch(() => {}); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    if (create && !passwordless && password !== confirmPassword) { setError(t("webAccount.passwordMismatch")); setBusy(false); return; }
    try {
      await post(create ? "register" : "login", {
        username, password: create && passwordless ? "" : password, ...(create && copy && local ? { localDb: base64(local) } : {}),
      });
      location.reload();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <main style={{ maxWidth: 470, margin: "0 auto", padding: "48px 16px" }}>
      <div className="logo" style={{ textAlign: "center", marginBottom: 16 }}>sprigo</div>
      <div className="card od-stack" style={{ "--od-gap": "14px" } as React.CSSProperties}>
        <h1 className="section-title" style={{ margin: 0 }}>{t(create ? "webAccount.create" : "webAccount.login")}</h1>
        <p className="muted small">{t("webAccount.description")}</p>
        <form className="od-stack" style={{ "--od-gap": "12px" } as React.CSSProperties} onSubmit={submit}>
          <label className="od-field"><b>{t("webAccount.username")}</b>
            <input className="input" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]{3,32}" value={username} onChange={(e) => setUsername(e.target.value)} />
            {create && <span className="muted small">{t("webAccount.usernameHint")}</span>}
          </label>
          {create && <label className="od-row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={passwordless} onChange={(e) => setPasswordless(e.target.checked)} />
            <span className="od-field"><b>{t("webAccount.passwordless")}</b>
              <span className="muted small">{t("webAccount.passwordlessHint")}</span></span>
          </label>}
          {(!create || !passwordless) && <label className="od-field"><b>{t("webAccount.password")}</b>
            <input className="input" type="password" autoComplete={create ? "new-password" : "current-password"} required={create} minLength={create ? 4 : 0} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="muted small">{t(create ? "webAccount.passwordHint" : "webAccount.loginPasswordHint")}</span>
          </label>}
          {create && !passwordless && <label className="od-field"><b>{t("webAccount.confirmPassword")}</b>
            <input className="input" type="password" autoComplete="new-password" required minLength={4} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </label>}
          {create && local && <label className="od-row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            <span className="small">{t("webAccount.copyLocal")}</span>
          </label>}
          {error && <p role="alert" className="small" style={{ color: "var(--red)" }}>{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy} type="submit">{t(create ? "webAccount.create" : "webAccount.login")}</button>
        </form>
        <button className="btn btn-ghost btn-block" onClick={() => { setCreate(!create); setError(""); }}>
          {t(create ? "webAccount.haveAccount" : "webAccount.newAccount")}
        </button>
        <button className="btn btn-ghost btn-block" onClick={() => choose("local")}>{t("webAccount.useLocal")}</button>
      </div>
    </main>
  );
}

export function WebAccessGate({ children }: { children: ReactNode }) {
  const [webMode] = useState<WebMode>(() => isWeb ? mode() : "local");
  const [checking, setChecking] = useState(isWeb && webMode === "account");
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    if (!isWeb || webMode !== "account") return;
    fetch("/account/me", { credentials: "same-origin" }).then(async (response) => {
      if (response.ok) { const data = await response.json(); noteSharedRevision(data.revision); setAccount(data.username); }
    }).catch(() => {}).finally(() => setChecking(false));
  }, [webMode]);
  useEffect(() => {
    if (!isWeb || webMode !== "account" || !account) return;
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/account/revision", { credentials: "same-origin", cache: "no-store" });
        if (response.status === 401) return location.reload();
        if (response.ok && (await response.json()).revision > seenSharedRevision()) location.reload();
      } catch { /* stay on the current page while the network is unavailable */ }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [webMode, account]);
  if (checking) return null;
  const value = {
    mode: webMode, account,
    useLocal: () => choose("local"), useAccount: () => choose("account"),
    signOut: async () => { await post("logout", {}); location.reload(); },
  };
  return <C.Provider value={value}>{isWeb && webMode === "account" && !account ? <AccountGate /> : children}</C.Provider>;
}

/** Visible both at the profile gate and in Settings, so either choice stays reversible. */
export function WebAccountControls() {
  const { t } = useTranslation();
  const access = useWebAccess();
  if (!isWeb) return null;
  return <div className="card od-stack" style={{ "--od-gap": "10px", marginTop: 14 } as React.CSSProperties}>
    <span className="od-field"><b>{t(access.mode === "account" ? "webAccount.sharedTitle" : "webAccount.localTitle")}</b>
      <span className="muted small">{access.mode === "account" ? t("webAccount.sharedDesc", { name: access.account }) : t("webAccount.localDesc")}</span>
    </span>
    <button className="btn btn-ghost btn-block" onClick={access.mode === "account" ? access.useLocal : access.useAccount}>
      {t(access.mode === "account" ? "webAccount.useLocal" : "webAccount.useShared")}
    </button>
    {access.mode === "account" && <button className="btn btn-ghost btn-block" onClick={() => void access.signOut()}>{t("webAccount.signOut")}</button>}
  </div>;
}
