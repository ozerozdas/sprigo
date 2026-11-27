import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../store";
import { languages } from "../i18n";
import type { ThemePref } from "../theme";
import { SMALL_MODEL_B, isSmallModel } from "../modelSize";
import { guideFor, verdictOf, type Measurement } from "../modelGuide";
import { MEASURED } from "../modelGuideData";
import { PROVIDERS, RECOMMENDED_OLLAMA, detectLocal, getKey, listModels, pullOllama, setKey, type AiConfig, type ProviderId } from "../ai";
import { cancelOpenRouter, signInOpenRouter } from "../oauth";
import { createPkce } from "../pkce";
import { aiUsage, aiUsageMonths, getSetting, isCompanion, isTauri, isWeb, setSetting } from "../db";
import { monthOf, summarize, type UsageMonth, type UsageRow } from "../usage";
import { setCompanion, tailscaleStatus, type TailscaleStatus } from "../companion";
import { CourseFlag, CourseSheet, NATIVE, ProfileForm, useLangName } from "./Profiles";
import { notifyAllowed } from "../notify";
import { betaOn, findUpdate, UpdateSheet } from "../Update";
import { DataRow } from "./DataSettings";
import { InfoTip, SttRow, TtsRow } from "./VoiceSettings";
import { Icon, type IconName } from "../icons";
import { HelpButton, HelpSheet, openLink } from "../Help";

const TEXT_SIZES = [1, 1.15, 1.3];
const gap = (g: string) => ({ "--od-gap": g }) as React.CSSProperties;

/** Related settings share one card; CSS draws a thin divider between the rows. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="card set-group">{children}</div>;
}

/** A boolean row's state at a glance: the track colour and the thumb's side carry it, so there is no text to translate. */
export function Switch({ checked, onChange, labelledBy, disabled }: {
  checked: boolean; onChange: (on: boolean) => void; labelledBy: string; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelledBy} disabled={disabled}
      className="switch" onClick={() => onChange(!checked)} />
  );
}

export function ToggleRow({ k, initial, onChange }: { k: string; initial: boolean; onChange?: (on: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  // ponytail: rows without onChange are visual only, as in the design; wired when each feature lands.
  const [on, setOnState] = useState(initial);
  const setOn = (v: boolean) => { setOnState(v); onChange?.(v); };
  return (
    <div className="od-row" style={gap("var(--s-4)")}>
      <b className="od-fill" id={id}>{t(`settings.${k}`)}</b>
      <InfoTip label={t("voice.about", { name: t(`settings.${k}`) })}>{t(`settings.${k}Desc`)}</InfoTip>
      <Switch checked={on} onChange={setOn} labelledBy={id} />
    </div>
  );
}

/** Desktop only: the phone companion server (docs/MOBILE.md). Needs Tailscale installed and signed in. */
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
function PhoneRow() {
  const { t } = useTranslation();
  const { toast, openSheet } = useApp();
  const id = useId();
  const [ts, setTs] = useState<TailscaleStatus | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { Promise.all([tailscaleStatus(), getSetting("companion")]).then(([s, v]) => { setTs(s); setOn(v === "on"); }); }, []);
  // The learner opens or signs in to Tailscale in its own app, then comes back here.
  useEffect(() => {
    const check = () => tailscaleStatus().then(setTs);
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  if (!ts) return null;
  const ready = ts.installed && ts.running;
  // Turning on (or the QR button) runs `tailscale serve` again: it's idempotent and returns the address to show.
  const turn = async (v: boolean) => {
    setBusy(true);
    try {
      const r = await setCompanion(v);
      await setSetting("companion", v ? "on" : "off");
      setOn(v);
      if (r) openSheet(<PhoneQrSheet url={r[0]} qr={r[1]} />);
    } catch (e) {
      const link = String(e).match(/https:\/\/\S+/)?.[0];
      link ? openSheet(<PhoneApproveSheet url={link} />) : toast(String(e));
      tailscaleStatus().then(setTs); // a failure may mean Tailscale quit or signed out meanwhile
    } finally { setBusy(false); }
  };
  const note = !ts.installed ? "settings.phoneMissing" : "settings.phoneSignIn"; // ready: the ⓘ sheet explains it
  return (
    <div className="od-row" style={gap("var(--s-4)")}>
      <span className="od-field od-fill"><b id={id}>{t("settings.phone")}</b>{!ready && <span className="muted small">{t(note)}</span>}</span>
      <button className="icon-btn" aria-label={t("settings.phoneAbout")} onClick={() => openSheet(<PhoneInfoSheet />)}><Icon name="info" /></button>
      {on && ready && <button className="icon-btn" aria-label={t("settings.phoneShowQr")} disabled={busy} onClick={() => turn(true)}><Icon name="qr" /></button>}
      {/* An unready Tailscale still lets the learner switch an old "on" off. */}
      <Switch checked={on} onChange={turn} labelledBy={id} disabled={busy || (!ready && !on)} />
    </div>
  );
}

function PhoneInfoSheet() {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  return (
    <div className="od-stack" style={gap("var(--s-4)")}>
      <div className="od-row" style={gap("var(--s-2)")}><h3>{t("settings.phone")}</h3><HelpButton topic="phone" /></div>
      <p className="muted">{t("settings.phoneDesc")}</p>
      <ol className="od-stack small" style={{ ...gap("var(--s-3)"), paddingLeft: "var(--s-6)" }}>
        <li>{t("settings.phoneHow1")}</li>
        <li>{t("settings.phoneHow2")}</li>
        <li>{t("settings.phoneHow3")}</li>
      </ol>
      <div className="od-stack sheet-actions" style={gap("var(--s-3)")}>
        <button className="btn btn-blue btn-block" onClick={() => openLink(TAILSCALE_DOWNLOAD)}>{t("settings.phoneGetTailscale")}</button>
        <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("settings.phoneOk")}</button>
      </div>
    </div>
  );
}

function PhoneQrSheet({ url, qr }: { url: string; qr: string }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  return (
    <div className="od-stack" style={{ ...gap("var(--s-4)"), alignItems: "center", textAlign: "center" }}>
      <h3>{t("settings.phoneScan")}</h3>
      <p className="muted small">{t("settings.phoneScanDesc")}</p>
      {/* SVG made by our own Rust side from the tailnet address; white behind it so dark mode still scans. */}
      <div style={{ background: "#fff", padding: "var(--s-3)", borderRadius: "var(--r)", lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: qr }} />
      <code className="small" style={{ userSelect: "all", overflowWrap: "anywhere" }}>{url}</code>
      <div className="od-stack sheet-actions" style={{ ...gap("var(--s-3)"), alignSelf: "stretch" }}>
        <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("settings.phoneOk")}</button>
      </div>
    </div>
  );
}

function PhoneApproveSheet({ url }: { url: string }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  return (
    <div className="od-stack" style={gap("var(--s-4)")}>
      <h3>{t("settings.phoneApprove")}</h3>
      <p className="muted">{t("settings.phoneApproveDesc")}</p>
      <div className="od-stack sheet-actions" style={gap("var(--s-3)")}>
        <button className="btn btn-blue btn-block" onClick={() => openLink(url)}>{t("settings.phoneApproveOpen")}</button>
        <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

const OLLAMA_DOWNLOAD = "https://ollama.com/download";
const AUTHOR_URL = "https://mehmetozer.dev";

/** First run: finds Ollama / LM Studio on this Mac, or helps install Ollama and pull a model. */
function LocalSetup({ onPick }: { onPick: (p: ProviderId, models: string[]) => void }) {
  const { t } = useTranslation();
  const [found, setFound] = useState<Awaited<ReturnType<typeof detectLocal>> | null>(null);
  const [pull, setPull] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const scan = async () => {
    setFound(null); setErr("");
    const f = await detectLocal();
    setFound(f);
    const p = f.ollama?.length ? "ollama" : f.lmstudio?.length ? "lmstudio" : null;
    if (p) onPick(p, f[p]!);
  };
  useEffect(() => { scan(); }, []);
  const download = async () => {
    setPull(0); setErr("");
    try { await pullOllama(PROVIDERS.ollama.baseURL, RECOMMENDED_OLLAMA.model, setPull); await scan(); }
    catch (e) { setErr((e as Error).message); }
    finally { setPull(null); }
  };

  if (!found) return <p className="muted small" role="status">{t("ai.scanning")}</p>;
  const name = found.ollama?.length ? "Ollama" : found.lmstudio?.length ? "LM Studio" : null;
  if (name) return <p className="small" role="status" style={{ color: "var(--green)" }}>{t("ai.foundLocal", { name })}</p>;
  return (
    <div className="card od-stack" style={gap("var(--s-4)")} role="status">
      <div className="od-row" style={{ ...gap("var(--s-3)"), justifyContent: "flex-end" }}>
        <HelpButton topic="aiConnect" />
      </div>
      {found.ollama ? <>
        <b>{t("ai.noModels")}</b>
        <span className="muted small">{t("ai.pullDesc", RECOMMENDED_OLLAMA)}</span>
        {pull === null
          ? <button className="btn btn-blue" onClick={download}>{t("ai.pull", RECOMMENDED_OLLAMA)}</button>
          : <div className="od-stack" style={gap("var(--s-3)")}>
              <div className="progress-track"><div className="progress-fill green" style={{ width: `${Math.round(pull * 100)}%` }} /></div>
              <span className="muted small">{t("ai.pulling", { pct: Math.round(pull * 100) })}</span>
            </div>}
      </> : <>
        <b>{t("ai.noLocal")}</b>
        <span className="muted small">{t("ai.noLocalDesc")}</span>
        <button className="btn btn-blue" onClick={() => openLink(OLLAMA_DOWNLOAD)}>{t("ai.getOllama")}</button>
        <button className="btn btn-ghost" onClick={scan}>{t("ai.rescan")}</button>
      </>}
      {err && <p className="small" style={{ color: "var(--red)", overflowWrap: "anywhere" }}>{err}</p>}
    </div>
  );
}

const AI_ROWS: { p: ProviderId; icon: IconName; color: string }[] = [
  { p: "ollama", icon: "lock", color: "var(--green)" },
  { p: "lmstudio", icon: "lock", color: "var(--green)" },
  { p: "openai", icon: "spark", color: "var(--blue)" },
  { p: "anthropic", icon: "spark", color: "var(--orange)" },
  { p: "gemini", icon: "spark", color: "var(--purple)" },
  { p: "openrouter", icon: "spark", color: "var(--red)" },
];

/** #48: what the learner's own key has cost, this month and earlier ones with usage, split by feature and model. */
function UsageSummary() {
  const { t, i18n } = useTranslation();
  const { openSheet } = useApp();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [month, setMonth] = useState<string>(() => monthOf());
  const [months, setMonths] = useState<string[]>(() => [monthOf()]);
  useEffect(() => {
    Promise.all([aiUsage(), aiUsageMonths()]).then(([r, ms]) => {
      setRows(r);
      const now = monthOf();
      setMonths([now, ...ms.filter((m) => m !== now)]);
    }).catch((e) => console.warn("usage", e)); // a missing reading must not break Settings
  }, []);
  const lang = i18n.resolvedLanguage ?? "en";
  const num = (v: number) => new Intl.NumberFormat(lang).format(v);
  const usd = (v: number) => new Intl.NumberFormat(lang, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 1 ? 4 : 2 }).format(v);
  const monthName = (m: string) => new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1));
  const data = summarize(rows, month);
  const cost = (priced: boolean, unpriced: boolean, v: number) => priced ? `${usd(v)}${unpriced ? "*" : ""}` : t("settings.usage.noPrice");
  return (<>
    <div className="od-row" style={{ ...gap("var(--s-3)"), flexWrap: "wrap" }}>
      <span className="od-field od-fill"><b>{t("settings.usage.title")}</b><span className="muted small">{t("settings.usage.desc")}</span></span>
      <select className="select" aria-label={t("settings.usage.month")} value={month} onChange={(e) => setMonth(e.target.value)}>
        {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
      </select>
      <button className="btn btn-ghost" onClick={() => openSheet(<UsageSheet data={data} month={monthName(month)} lang={lang} />)}>
        {t("settings.usage.details")}
      </button>
    </div>
    {!data.features.length
      ? <p className="muted small">{t("settings.usage.empty")}</p>
      : <div className="od-row" style={gap("var(--s-4)")}>
          <span className="od-field od-fill"><b>{t("settings.usage.total")}</b>
            <span className="muted small">{t("settings.usage.tokens", { input: num(data.input), output: num(data.output) })}</span></span>
          <span className="od-field" style={{ textAlign: "end" }}><b>{cost(data.priced, data.unpriced, data.usd)}</b>
            <span className="muted small">{t("settings.usage.estimate")}</span></span>
        </div>}
  </>);
}

/** The per-feature breakdown, behind Token usage's Details button: the row above stays one line. */
function UsageSheet({ data, month, lang }: { data: UsageMonth; month: string; lang: string }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  const num = (v: number) => new Intl.NumberFormat(lang).format(v);
  const usd = (v: number) => new Intl.NumberFormat(lang, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 1 ? 4 : 2 }).format(v);
  const cost = (priced: boolean, unpriced: boolean, v: number) => priced ? `${usd(v)}${unpriced ? "*" : ""}` : t("settings.usage.noPrice");
  return (
    <div className="od-stack" style={{ ...gap("var(--s-4)"), textAlign: "left" }}>
      <h3>{t("settings.usage.title")}</h3>
      <p className="muted small" style={{ marginBottom: 0 }}>{month}</p>
      {!data.features.length
        ? <p className="muted small">{t("settings.usage.empty")}</p>
        : <>
            <div className="od-row" style={gap("var(--s-4)")}>
              <span className="od-field od-fill"><b>{t("settings.usage.total")}</b>
                <span className="muted small">{t("settings.usage.tokens", { input: num(data.input), output: num(data.output) })}</span></span>
              <span className="od-field" style={{ textAlign: "end" }}><b>{cost(data.priced, data.unpriced, data.usd)}</b>
                <span className="muted small">{t("settings.usage.estimate")}</span></span>
            </div>
            {data.features.map((f) => (
              <div key={f.feature} className="od-row" style={gap("var(--s-4)")}>
                <span className="od-field od-fill"><b>{t(`settings.usage.features.${f.feature}`)}</b>
                  <span className="muted small">{t("settings.usage.tokens", { input: num(f.input), output: num(f.output) })}</span>
                  <span className="muted small od-anywhere">
                    {f.models.map((m) => `${PROVIDERS[m.provider as ProviderId]?.label ?? m.provider} · ${m.model}`).join(", ")}
                  </span></span>
                <b className="small">{cost(f.priced, f.unpriced, f.usd)}</b>
              </div>
            ))}
            <p className="muted small" style={{ marginBottom: 0 }}>{t("settings.usage.note")}</p>
          </>}
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.close")}</button>
    </div>
  );
}

/** DECISIONS C1/C6: device-wide provider, key in the OS keychain. One row per provider; picking one opens its settings. */
export function AiSheet() {
  const { t } = useTranslation();
  const { ai, aiBackup, openSheet, closeSheet } = useApp();
  const [found, setFound] = useState<{ p: ProviderId; models: string[] } | null>(null); // first run: a local server with models
  const configure = (p: ProviderId) => openSheet(<AiConfigSheet provider={p} models={found?.p === p ? found.models : []} />);
  return (
    <div className="od-stack" style={{ ...gap("var(--s-5)"), textAlign: "left" }}>
      <div className="od-row" style={{ ...gap("var(--s-2)"), justifyContent: "center" }}><h3>{t("ai.title")}</h3><HelpButton topic="ai" /></div>
      {ai && <p className="muted small">{t("ai.backupDesc")}</p>}
      {!ai && <LocalSetup onPick={(p, models) => setFound({ p, models })} />}
      <div className="od-stack" style={gap("var(--s-3)")} role="radiogroup" aria-label={t("ai.provider")}>
        {AI_ROWS.map(({ p, icon, color }) => (
          <div key={p} className={`voice-option${ai?.provider === p ? " on" : ""}`}>
            <button role="radio" aria-checked={ai?.provider === p} onClick={() => ai?.provider !== p && configure(p)}>
              <span className="voice-icon" style={{ color }}><Icon name={icon} /></span>
              <span className="od-field od-fill"><b>{PROVIDERS[p].label}</b>
                <span className="muted small">{ai?.provider === p ? `${ai.model} · ` : aiBackup?.provider === p ? `${t("ai.backup")}: ${aiBackup.model} · ` : ""}{t(`ai.${p}Good`)}</span></span>
            </button>
            <button className="icon-btn" aria-label={t("ai.configure", { name: PROVIDERS[p].label })} onClick={() => configure(p)}><Icon name="gear" /></button>
            <InfoTip label={t("voice.about", { name: PROVIDERS[p].label })}>{t(`ai.${p}Info`)}</InfoTip>
          </div>
        ))}
      </div>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  );
}

/** What the model measured like (#37): pnpm bench latency and pnpm eval quality, bundled in modelGuideData.ts. */
function ModelGuide({ m }: { m: Measurement }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? "en";
  const pct = Math.round(m.quality);
  const secs = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(m.sayMs / 1000);
  const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${m.measured}T12:00:00`));
  const verdict = verdictOf(m);
  return (
    <span className="small" style={{ color: verdict === "good" ? "var(--green)" : "var(--orange)" }}>
      {t(`ai.guide.${verdict}`, { pct })}
      <span className="muted"> · {t("ai.guide.details", { secs, pct, hardware: m.hardware, date })}</span>
    </span>
  );
}

/** One provider's server, key and model; saving makes it the active provider. */
function AiConfigSheet({ provider, models: found }: { provider: ProviderId; models: string[] }) {
  const { t } = useTranslation();
  const { ai, setAi, aiBackup, setAiBackup, toast, openSheet } = useApp();
  const mine = ai?.provider === provider ? ai : aiBackup?.provider === provider ? aiBackup : null;
  const isBackup = aiBackup?.provider === provider;
  const [baseURL, setBaseURL] = useState(mine?.baseURL ?? PROVIDERS[provider].baseURL);
  const [model, setModel] = useState(mine?.model ?? (found.includes(RECOMMENDED_OLLAMA.model) ? RECOMMENDED_OLLAMA.model : found[0] ?? ""));
  const [key, setKeyState] = useState("");
  const [models, setModels] = useState(found);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const needsKey = PROVIDERS[provider].needsKey;
  const back = () => openSheet(<AiSheet />);

  useEffect(() => { getKey(provider).then((k) => setKeyState(k ?? "")); }, [provider]);
  // Closing the sheet abandons a sign-in that is still waiting for the browser.
  const attempt = useRef<string | null>(null);
  useEffect(() => () => { if (attempt.current) void cancelOpenRouter(attempt.current); }, []);
  const cfg: AiConfig = { provider, baseURL: baseURL.trim(), model: model.trim() };
  // The measured guidance sits outside the label and is linked by aria-describedby, so it does not become part of the
  // field's accessible name. A small model keeps the size warning even when it was measured.
  const measured = needsKey ? null : guideFor(cfg.model, MEASURED);
  const small = !needsKey && isSmallModel(cfg.model);

  const test = async () => {
    setBusy(true); setStatus(null);
    try {
      const list = await listModels(cfg, key || null);
      setModels(list);
      if (!model && list[0]) setModel(list[0]);
      setStatus({ ok: true, msg: t("ai.connected", { count: list.length }) });
    } catch (e) { setStatus({ ok: false, msg: `${t("ai.connectFailed")}: ${e instanceof Error ? e.message : String(e)}` }); }
    finally { setBusy(false); }
  };
  // #197: one click in the browser; Rust exchanges the code and writes the key to the keychain.
  const signIn = async () => {
    setSigningIn(true); setStatus(null);
    let pkce: Awaited<ReturnType<typeof createPkce>> | undefined;
    try {
      pkce = await createPkce();
      attempt.current = pkce.state;
      const r = await signInOpenRouter(pkce);
      if (r === "cancelled") return; // the learner closed the tab or the sheet
      if (r === "timeout") { setStatus({ ok: false, msg: t("ai.openrouterTimeout") }); return; }
      const k = (await getKey(provider)) ?? "";
      setKeyState(k);
      setStatus({ ok: true, msg: t("ai.openrouterSignedIn") });
      try {
        const list = await listModels(cfg, k);
        setModels(list);
        if (!model && list[0]) setModel(list[0]);
      } catch { /* the key is saved; Test shows what the model list could not load */ }
    } catch (e) {
      setStatus({ ok: false, msg: `${t("ai.openrouterFailed")}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (attempt.current === pkce?.state) attempt.current = null; // nothing left to cancel on close
      setSigningIn(false);
    }
  };
  const save = async (asBackup = false) => {
    setBusy(true);
    try {
      if (needsKey) await setKey(provider, key.trim() || null);
      await (asBackup ? setAiBackup(cfg) : setAi(cfg));
      toast(t(asBackup ? "ai.backupSaved" : "ai.saved"));
      back();
    } catch (e) { setStatus({ ok: false, msg: (e as Error).message }); setBusy(false); }
  };
  const unsetBackup = async () => { await setAiBackup(null); toast(t("ai.backupRemoved")); back(); };

  return (
    <div className="od-stack" style={{ ...gap("var(--s-5)"), textAlign: "left" }}>
      <h3 className="od-center">{PROVIDERS[provider].label}</h3>
      <p className="small">{t(`ai.${provider}Info`)}</p>
      <label className="od-field"><b>{t("ai.baseURL")}</b>
        <input className="input" value={baseURL} spellCheck={false} onChange={(e) => setBaseURL(e.target.value)} placeholder={PROVIDERS[provider].baseURL} />
      </label>
      {needsKey && (
        <label className="od-field"><b>{t("ai.apiKey")}</b><span className="muted small">{t("ai.apiKeyDesc")}</span>
          <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKeyState(e.target.value)} />
        </label>
      )}
      {provider === "openrouter" && isTauri && (
        <div className="od-stack" style={gap("var(--s-2)")}>
          <button className="btn btn-ghost btn-block" disabled={busy || signingIn} onClick={signIn}>
            {t(signingIn ? "ai.openrouterSigningIn" : "ai.openrouterSignIn")}
          </button>
          <span className="muted small">{t("ai.openrouterSignInHint")}</span>
        </div>
      )}
      <label className="od-field"><b>{t("ai.model")}</b><span className="muted small">{t("ai.modelDesc")}</span>
        <input className="input" list="ai-models" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)}
          aria-describedby={measured || small ? "ai-model-note" : undefined} />
        <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {(measured || small) && (
        <div id="ai-model-note" className="od-stack" style={gap("2px")} role="note">
          {measured && <ModelGuide m={measured} />}
          {small && <span className="small" style={{ color: "var(--orange)" }}>{t("ai.smallModel", { min: `${SMALL_MODEL_B}B` })}</span>}
        </div>
      )}
      {status && <p className="small" role="status" style={{ color: status.ok ? "var(--green)" : "var(--red)", overflowWrap: "anywhere" }}>{status.msg}</p>}
      <div className="od-stack sheet-actions" style={gap("var(--s-3)")}>
        <div className="od-row" style={gap("var(--s-3)")}>
          <button className="btn btn-ghost" disabled={busy || signingIn || (needsKey && !key.trim())} onClick={test}>{t("ai.test")}</button>
          <button className="btn btn-primary od-fill" disabled={busy || signingIn || !cfg.model || (needsKey && !key.trim())} onClick={() => save()}>{t("ai.save")}</button>
        </div>
        {ai && ai.provider !== provider && (isBackup
          ? <button className="btn btn-ghost btn-block" disabled={busy} onClick={unsetBackup}>{t("ai.removeBackup")}</button>
          : <button className="btn btn-ghost btn-block" disabled={busy || signingIn || !cfg.model || (needsKey && !key.trim())} onClick={() => save(true)}>{t("ai.saveBackup")}</button>)}
        <button className="btn btn-ghost btn-block" onClick={back}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

function VersionRow() {
  const { t } = useTranslation();
  const { openSheet, toast } = useApp();
  const [version, setVersion] = useState("dev");
  const [busy, setBusy] = useState(false);
  const [beta, setBeta] = useState<boolean | null>(null);
  useEffect(() => { if (isTauri) { import("@tauri-apps/api/app").then((a) => a.getVersion()).then(setVersion); betaOn().then(setBeta); } }, []);
  const check = async () => {
    setBusy(true);
    const u = await findUpdate();
    setBusy(false);
    u ? openSheet(<UpdateSheet update={u} />) : toast(t("update.none"));
  };
  return (<>
    <div className="od-row" style={gap("var(--s-4)")}>
      <b className="od-fill">{t("update.version", { version })}</b>
      <InfoTip label={t("voice.about", { name: t("update.section") })}>{t("update.desc")}</InfoTip>
      <button className="btn btn-ghost" disabled={busy} onClick={check}>{t("update.check")}</button>
    </div>
    {beta !== null && <ToggleRow k="betaUpdates" initial={beta} onChange={(on) => setSetting("update.beta", on ? "1" : null)} />}
    </>
  );
}

type Tab = "profile" | "prefs" | "ai" | "privacy";

export function Settings() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme, course, enrollment, profile, updateProfile, openSheet, closeSheet, logout, ai, s, setS, toast } = useApp();
  const langName = useLangName();
  const themes: ThemePref[] = ["system", "light", "dark"];
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  // Phone: AI, voice and data settings are the desktop's (shared database), so those tabs stay there.
  const tabs: Tab[] = isCompanion ? (isWeb ? ["profile", "prefs", "ai"] : ["profile", "prefs"]) : ["profile", "prefs", "ai", "privacy"];
  const [tab, setTab] = useState<Tab>(ai || isCompanion ? "profile" : "ai"); // AI not set up yet → its tab, so the warning shows
  return (
    <>
      <h1 className="section-title" style={{ marginTop: "var(--s-6)" }}>{t("settings.title")}</h1>
      <div className="tabs" role="tablist" aria-label={t("settings.title")}>
        {tabs.map((k) => (
          <button key={k} role="tab" id={`set-tab-${k}`} aria-selected={tab === k} aria-controls="set-panel" onClick={() => setTab(k)}>
            {t(`settings.tabs.${k}`)}{k === "ai" && !ai && <span className="tab-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div id="set-panel" role="tabpanel" aria-labelledby={`set-tab-${tab}`} className="od-stack" style={gap("var(--s-4)")}>
        {tab === "profile" && <>
          <Group>
            <div className="od-row">
              <span style={{ fontSize: "var(--fs-24)" }}>{course && <CourseFlag c={course} />}</span>
              <span className="od-field od-fill"><b>{course ? langName(course.iso) : "—"}</b>
                <span className="muted small">{t("settings.courseDesc", {
                  level: enrollment && t(`levels.${enrollment.level}`, { defaultValue: course?.levels[enrollment.level]?.title ?? enrollment.level }),
                  native: langName(profile!.native_lang),
                })}</span></span>
              <button className="btn btn-ghost" onClick={() => openSheet(<CourseSheet />)}>{t("settings.change")}</button>
            </div>
            <div className="od-row" style={gap("var(--s-4)")}>
              <label className="od-field od-fill" htmlFor="native-lang"><b>{t("profiles.native")}</b><span className="muted small">{t("profiles.nativeDesc")}</span></label>
              <select id="native-lang" className="select" value={profile!.native_lang} onChange={(e) => updateProfile({ native_lang: e.target.value })}>
                {NATIVE.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
              </select>
            </div>
            <div className="od-row" style={gap("var(--s-4)")}>
              <label className="od-field od-fill" htmlFor="ui-lang"><b>{t("settings.language")}</b></label>
              <select id="ui-lang" className="select" value={i18n.resolvedLanguage} onChange={(e) => { i18n.changeLanguage(e.target.value); updateProfile({ ui_lang: e.target.value }); }}>
                {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
            <div className="od-row" style={gap("var(--s-4)")}>
              <span className="od-field od-fill"><b>{profile!.name}</b><span className="muted small">{t("settings.profileDesc")}</span></span>
              <button className="btn btn-ghost" onClick={() => openSheet(<><h3 style={{ marginBottom: "var(--s-5)" }}>{t("settings.editProfile")}</h3><ProfileForm initial={profile!} onDone={closeSheet} /></>)}>{t("settings.edit")}</button>
            </div>
          </Group>
          <button className="btn btn-ghost btn-block mobile-only" onClick={logout}>{t("settings.logout")}</button>
          <Group>
            <div className="od-row" style={gap("var(--s-4)")}>
              <span className="od-field od-fill"><b>{t("help.title")}</b><span className="muted small">{t("help.tagline")}</span></span>
              <button className="btn btn-ghost" onClick={() => openSheet(<HelpSheet />)}>{t("help.view")}</button>
            </div>
            {!isCompanion && <VersionRow />}
          </Group>
        </>}

        {tab === "prefs" && <>
          <Group>
            <ToggleRow k="hearts" initial={s.heartsOn} onChange={(heartsOn) => setS((s) => ({ ...s, heartsOn }))} />
            <ToggleRow k="sound" initial={s.soundOn} onChange={(soundOn) => setS((s) => ({ ...s, soundOn }))} />
            <ToggleRow k="speaking" initial={s.speakOn} onChange={(speakOn) => setS((s) => ({ ...s, speakOn }))} />
            <ToggleRow k="bargeIn" initial={s.bargeIn} onChange={(bargeIn) => setS((s) => ({ ...s, bargeIn }))} />
            {!isCompanion && <ToggleRow k="reminder" initial={s.reminderOn} onChange={async (reminderOn) => {
              setS((s) => ({ ...s, reminderOn }));
              if (reminderOn && !(await notifyAllowed())) toast(t("settings.reminderBlocked"));
            }} />}
            <ToggleRow k="reduceMotion" initial={s.reduceMotion} onChange={(reduceMotion) => setS((s) => ({ ...s, reduceMotion }))} />
            {isCompanion && <TtsRow />}
          </Group>
          <h2 className="section-title">{t("settings.appearance")}</h2>
          <Group>
            <div className="od-row" style={{ ...gap("var(--s-4)"), flexWrap: "wrap" }}>
              <b className="od-fill">{t("settings.theme")}</b>
              <div className="seg" role="radiogroup" aria-label={t("settings.theme")}>
                {themes.map((th) => (
                  <button key={th} role="radio" aria-checked={theme === th} className={`btn ${theme === th ? "btn-blue" : "btn-ghost"}`} onClick={() => setTheme(th)}>
                    {t(`settings.theme${cap(th)}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="od-row" style={{ ...gap("var(--s-4)"), flexWrap: "wrap" }}>
              <b className="od-fill">{t("settings.textSize")}</b>
              <div className="seg" role="radiogroup" aria-label={t("settings.textSize")}>
                {TEXT_SIZES.map((f) => (
                  <button key={f} role="radio" aria-checked={s.textSize === f} className={`btn ${s.textSize === f ? "btn-blue" : "btn-ghost"}`} onClick={() => setS((s) => ({ ...s, textSize: f }))}>
                    {Math.round(f * 100)}%
                  </button>
                ))}
              </div>
            </div>
            <ToggleRow k="readableFont" initial={s.readableFont} onChange={(readableFont) => setS((s) => ({ ...s, readableFont }))} />
            <ToggleRow k="highContrast" initial={s.highContrast} onChange={(highContrast) => setS((s) => ({ ...s, highContrast }))} />
          </Group>
        </>}

        {tab === "ai" && <>
          <Group>
            <div className="od-row" style={gap("var(--s-4)")}>
              <span className="od-field od-fill"><b>{t("ai.title")}</b>
                {ai ? <span className="muted small od-anywhere">{PROVIDERS[ai.provider].label} · {ai.model}</span>
                  : <span className="small" style={{ color: "var(--orange)", fontWeight: 800 }}>{t("ai.notSet")}</span>}</span>
              <button className={`btn ${ai ? "btn-ghost" : "btn-primary"}`} onClick={() => openSheet(<AiSheet />)}>{t(ai ? "settings.change" : "ai.setUp")}</button>
            </div>
            <UsageSummary />
            <TtsRow />
            <SttRow />
          </Group>
        </>}

        {tab === "privacy" && (
          <Group>
            <ToggleRow k="memory" initial={s.memoryOn} onChange={(memoryOn) => setS((s) => ({ ...s, memoryOn }))} />
            <ToggleRow k="speech" initial={s.speechOn} onChange={(speechOn) => setS((s) => ({ ...s, speechOn }))} />
            <DataRow />
            {isTauri && <PhoneRow />}
          </Group>
        )}
      </div>

      <p className="muted small" style={{ textAlign: "center", marginTop: "var(--s-3)" }}>
        {t("update.madeBy")} <a href={AUTHOR_URL} onClick={(e) => { e.preventDefault(); void openLink(AUTHOR_URL); }}>mehmetozer.dev</a>
      </p>
    </>
  );
}
