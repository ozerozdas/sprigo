// Settings > AI and voice: speech provider rows and their sheets.
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../store";
import { getSetting, isCompanion, isTauri, setSetting } from "../db";
import { elevenVoice, getElevenKey, loadKokoro, loadPiper, localTts, sayWithEleven, sayWithLocal, setElevenKey, speak, speakingWith, TTS_KEY, ttsProvider, ttsSpeaks, useTtsPreparing, ACCENTS, SPEED, ttsAccent, ttsSpeed, type TtsProvider } from "../tts";
import { ELEVEN_VOICES, LOCAL_TTS } from "../ttsCloud";
import { Icon } from "../icons";
import { HelpButton } from "../Help";
import { deepgramTranscribe, downloadWhisper, getDeepgramKey, listen, pickWhisper, removeWhisper, resetSttReady, setDeepgramKey, sttProvider, sttReady, whisperModels, type Listener, type SttProvider, type WhisperModel } from "../stt";
import { isNoise } from "../tutor";
import { useLangName } from "./Profiles";
import { wav16 } from "../wav";

const gap = (g: string) => ({ "--od-gap": g }) as React.CSSProperties;
const sheet = { ...gap("14px"), textAlign: "left" } as React.CSSProperties;

const TTS = [
  { p: "system", bars: 1, color: "var(--orange)" },
  { p: "piper", bars: 2, color: "var(--gold)" },
  { p: "kokoro", bars: 3, color: "var(--green)" },
  { p: "elevenlabs", bars: 3, color: "var(--blue)" },
  { p: "local", bars: 3, color: "var(--purple)" },
] as const;
const ttsName = (p: TtsProvider) => `settings.tts${p[0].toUpperCase()}${p.slice(1)}`;
const HELLO: Record<string, string> = {
  en: "Hello! Nice to meet you. How are you today?", tr: "Merhaba! Tanıştığıma memnun oldum. Bugün nasılsın?",
  de: "Hallo! Schön, dich kennenzulernen. Wie geht es dir heute?", fr: "Bonjour ! Ravi de te rencontrer. Comment vas-tu aujourd'hui ?",
  es: "¡Hola! Encantado de conocerte. ¿Cómo estás hoy?", hu: "Szia! Örülök, hogy megismerhetlek. Hogy vagy ma?",
};

/** Voice quality as signal bars: more bars, more natural. */
const Signal = ({ bars, color }: { bars: number; color: string }) => (
  <svg className="tts-signal" viewBox="0 0 20 20" aria-hidden="true" style={{ color }}>
    {[0, 1, 2].map((k) => <rect key={k} x={2 + k * 6} y={12 - k * 5} width="4" height={6 + k * 5} rx="1.5" fill="currentColor" opacity={k < bars ? 1 : 0.25} />)}
  </svg>
);

/** An info icon whose note shows on hover, focus or tap. */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="voice-info">
      <button className="icon-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" /></button>
      <span className={`voice-tip${open ? " open" : ""}`} role="tooltip">{children}</span>
    </span>
  );
}

export function TtsRow() {
  const { t } = useTranslation();
  const { openSheet, course } = useApp();
  const langName = useLangName();
  const lang = course?.iso ?? "en";
  const [v, setV] = useState<TtsProvider>("system");
  useEffect(() => { ttsProvider().then(setV); }, []);
  const now = speakingWith(); // the last line spoke with another engine than the saved one (it fell back)
  return (
    <div className="card od-row" style={gap("12px")}>
      <span className="od-field od-fill"><b>{t("settings.tts")}</b><span className="muted small">{t(ttsName(v))}</span>
        {now && now !== v && <span className="small" style={{ color: "var(--orange)" }}>{t("voice.using", { name: t(`voice.engine.${now}`) })}</span>}
        {!ttsSpeaks(v, lang) && <span className="small" style={{ color: "var(--orange)" }}>{t("voice.notForLang", { lang: langName(lang) })}</span>}</span>
      <HelpButton topic="voice" />
      <button className="btn btn-ghost" onClick={() => openSheet(<TtsSheet initial={v} onChange={setV} />)}>{t("settings.change")}</button>
    </div>
  );
}

function TtsSheet({ initial, onChange }: { initial: TtsProvider; onChange: (v: TtsProvider) => void }) {
  const { t } = useTranslation();
  const { course, closeSheet, openSheet } = useApp();
  const langName = useLangName();
  const lang = course?.iso ?? "en";
  const hello = HELLO[lang] ?? HELLO.en, testing = useTtsPreparing(hello);
  const [v, setV] = useState(initial);
  const [pct, setPct] = useState<number | null>(null); // a local voice downloading
  const [err, setErr] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [hasLocal, setHasLocal] = useState(false); // a local server was set up once
  const [speed, setSpeed] = useState(1);
  const accents = ACCENTS[lang.slice(0, 2)];
  const [accent, setAccent] = useState<string | undefined>();
  useEffect(() => {
    getElevenKey().then((k) => setHasKey(!!k)).catch(() => {});
    getSetting("tts.local").then((x) => setHasLocal(!!x));
    ttsSpeed().then(setSpeed);
    ttsAccent(lang).then(setAccent);
  }, []);
  const pickSpeed = (x: number) => { setSpeed(x); setSetting("tts.speed", x === 1 ? null : String(x)); };
  // Piper has a voice per accent: download it now, like picking Piper does.
  const pickAccent = async (a: string) => {
    if (pct !== null) return;
    await setSetting(`tts.accent.${lang.slice(0, 2)}`, a);
    setAccent(a);
    if (v !== "piper") return;
    setErr(""); setPct(0);
    try { await loadPiper(lang, setPct); }
    catch (e) { setErr(t("voice.loadFailed", { name: t(ttsName("piper")), error: (e as Error).message })); }
    setPct(null);
  };
  const back = () => openSheet(<TtsSheet initial={v} onChange={onChange} />);
  const configureLocal = () => openSheet(<LocalTtsSheet onSaved={() => { onChange("local"); openSheet(<TtsSheet initial="local" onChange={onChange} />); }} onCancel={back} />);
  // ElevenLabs needs its key first: without one, picking it opens the key sheet; the gear always opens it.
  const configure = () => openSheet(<ElevenSheet onSaved={() => { onChange("elevenlabs"); openSheet(<TtsSheet initial="elevenlabs" onChange={onChange} />); }}
    onCancel={back} />);
  // Picking saves; a local voice only once its model has loaded, otherwise the choice stays where it was.
  const pick = async (next: TtsProvider) => {
    if (pct !== null || next === v) return;
    setErr("");
    if (next === "elevenlabs" && !hasKey) return configure();
    if (next === "local" && !hasLocal) return configureLocal();
    if (next === "piper" || next === "kokoro") {
      setPct(0);
      try { await (next === "kokoro" ? loadKokoro(setPct) : loadPiper(lang, setPct)); }
      catch (e) { setErr(t("voice.loadFailed", { name: t(ttsName(next)), error: (e as Error).message })); setPct(null); return; }
      setPct(null);
    }
    await setSetting(TTS_KEY, next);
    setV(next); onChange(next);
  };
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("settings.tts")}</h3>
      <div className="od-stack" style={gap("8px")} role="radiogroup" aria-label={t("settings.tts")}>
        {TTS.filter(({ p }) => !(isCompanion && p !== "system" && p !== "piper")).map(({ p, bars, color }) => (
          <div key={p} className={`voice-option${v === p ? " on" : ""}`}>
            <button role="radio" aria-checked={v === p} disabled={pct !== null || !ttsSpeaks(p, lang)} onClick={() => pick(p)}>
              <Signal bars={bars} color={color} />
              <span className="od-field od-fill"><b>{t(ttsName(p))}</b>
                <span className="muted small">{ttsSpeaks(p, lang) ? t(`voice.${p}Good`) : t("voice.notForLang", { lang: langName(lang) })}</span></span>
            </button>
            {p === "elevenlabs" && <button className="icon-btn" aria-label={t("voice.configure", { name: "ElevenLabs" })} onClick={configure}><Icon name="gear" /></button>}
            {p === "kokoro" && <InfoTip label={t("voice.about", { name: "Kokoro" })}>{t("voice.kokoroDesc")} {t("voice.englishOnly")}</InfoTip>}
            {p === "local" && <button className="icon-btn" aria-label={t("voice.configure", { name: t("settings.ttsLocal") })} onClick={configureLocal}><Icon name="gear" /></button>}
            {p === "elevenlabs" && <InfoTip label={t("voice.about", { name: "ElevenLabs" })}>{t("voice.elevenlabsDesc")}</InfoTip>}
            {p === "local" && <InfoTip label={t("voice.about", { name: t("settings.ttsLocal") })}>{t("voice.localDesc")}</InfoTip>}
          </div>
        ))}
      </div>
      <label className="od-stack" style={gap("4px")}>
        <span className="small"><b>{t("voice.speed")}</b> <span className="muted">{speed.toFixed(1)}×</span></span>
        <input type="range" min={SPEED.min} max={SPEED.max} step={0.1} value={speed} onChange={(e) => pickSpeed(Number(e.target.value))} />
      </label>
      {accents && (
        <div className="od-stack" style={gap("6px")}>
          <span id="tts-accent" className="small"><b>{t("voice.accent")}</b></span>
          <div className="seg" role="radiogroup" aria-labelledby="tts-accent">
            {accents.map((a) => {
              const on = (accent ?? accents[0]) === a;
              return <button key={a} role="radio" aria-checked={on} disabled={pct !== null} className={`btn ${on ? "btn-blue" : "btn-ghost"}`} onClick={() => pickAccent(a)}>{t(`voice.accent_${a}`)}</button>;
            })}
          </div>
        </div>
      )}
      {pct !== null && (
        <div className="od-stack" style={gap("6px")} role="status">
          <div className="progress-track"><div className="progress-fill green" style={{ width: `${Math.round(pct * 100)}%` }} /></div>
          <span className="muted small">{t("voice.downloading", { pct: Math.round(pct * 100) })}</span>
        </div>
      )}
      {err && <p className="small" role="status" style={{ color: "var(--red)", overflowWrap: "anywhere" }}>{err}</p>}
      <div className="od-stack sheet-actions" style={gap("8px")}>
        <button className="btn btn-blue btn-block" disabled={pct !== null || testing} aria-busy={testing} onClick={() => speak(hello, lang, { gender: "f" })}>{t("voice.listen")}</button>
        <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

/** The ElevenLabs key and voices: test them, then save and switch the voice to ElevenLabs. */
function ElevenSheet({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { toast, course } = useApp();
  const lang = course?.iso ?? "en";
  const [key, setKey] = useState("");
  const [vf, setVf] = useState("");
  const [vm, setVm] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getElevenKey().then((k) => setKey(k ?? "")).catch(() => {});
    elevenVoice("f").then((x) => setVf(x === ELEVEN_VOICES.f ? "" : x));
    elevenVoice("m").then((x) => setVm(x === ELEVEN_VOICES.m ? "" : x));
  }, []);
  const test = async () => {
    setBusy(true); setStatus(null);
    try {
      await sayWithEleven(HELLO[lang] ?? HELLO.en, lang, key.trim(), vf.trim() || ELEVEN_VOICES.f);
      setStatus({ ok: true, msg: t("voice.connected") });
    } catch (e) { setStatus({ ok: false, msg: `${t("ai.connectFailed")}: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await setElevenKey(key.trim());
      await setSetting("tts.eleven.voice.f", vf.trim() || null);
      await setSetting("tts.eleven.voice.m", vm.trim() || null);
      await setSetting(TTS_KEY, "elevenlabs");
      toast(t("voice.saved"));
      onSaved();
    } catch (e) { setStatus({ ok: false, msg: (e as Error).message }); setBusy(false); }
  };
  const voiceField = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label className="od-field"><b>{label}</b>
      <input className="input" spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("settings.ttsElevenlabs")}</h3>
      <p className="small">{t("voice.elevenlabsDesc")}</p>
      <label className="od-field"><b>{t("voice.elevenKey")}</b><span className="muted small">{t("ai.apiKeyDesc")}</span>
        <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      {voiceField(t("voice.elevenVoiceF"), vf, setVf, ELEVEN_VOICES.f)}
      {voiceField(t("voice.elevenVoiceM"), vm, setVm, ELEVEN_VOICES.m)}
      {status && <p className="small" role="status" style={{ color: status.ok ? "var(--green)" : "var(--red)", overflowWrap: "anywhere" }}>{status.msg}</p>}
      <div className="od-stack sheet-actions" style={gap("8px")}>
        <div className="od-row" style={gap("8px")}>
          <button className="btn btn-ghost" disabled={busy || !key.trim()} onClick={test}>{t("ai.test")}</button>
          <button className="btn btn-primary od-fill" disabled={busy || !key.trim()} onClick={save}>{t("ai.save")}</button>
        </div>
        <button className="btn btn-ghost btn-block" onClick={onCancel}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

/** A local OpenAI-compatible speech server (e.g. Kokoro-FastAPI): address, model and voice; test, then save and switch to it. */
function LocalTtsSheet({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { toast, course } = useApp();
  const lang = course?.iso ?? "en";
  const [c, setC] = useState(LOCAL_TTS);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { localTts().then(setC); }, []);
  const cfg = { baseURL: c.baseURL.trim(), model: c.model.trim(), voice: c.voice.trim() };
  const ready = !!(cfg.baseURL && cfg.model && cfg.voice);
  const test = async () => {
    setBusy(true); setStatus(null);
    try { await sayWithLocal(HELLO[lang] ?? HELLO.en, cfg); setStatus({ ok: true, msg: t("voice.connected") }); }
    catch (e) { setStatus({ ok: false, msg: `${t("ai.connectFailed")}: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    await setSetting("tts.local", JSON.stringify(cfg));
    await setSetting(TTS_KEY, "local");
    toast(t("voice.saved"));
    onSaved();
  };
  const field = (k: keyof typeof c, label: string) => (
    <label className="od-field"><b>{label}</b>
      <input className="input" spellCheck={false} value={c[k]} placeholder={LOCAL_TTS[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("settings.ttsLocal")}</h3>
      <p className="small">{t("voice.localDesc")}</p>
      {field("baseURL", t("voice.localUrl"))}
      {field("model", t("voice.localModel"))}
      {field("voice", t("voice.localVoice"))}
      {status && <p className="small" role="status" style={{ color: status.ok ? "var(--green)" : "var(--red)", overflowWrap: "anywhere" }}>{status.msg}</p>}
      <div className="od-stack sheet-actions" style={gap("8px")}>
        <div className="od-row" style={gap("8px")}>
          <button className="btn btn-ghost" disabled={busy || !ready} onClick={test}>{t("ai.test")}</button>
          <button className="btn btn-primary od-fill" disabled={busy || !ready} onClick={save}>{t("ai.save")}</button>
        </div>
        <button className="btn btn-ghost btn-block" onClick={onCancel}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

export function SttRow() {
  const { t } = useTranslation();
  const { openSheet, course } = useApp();
  const langName = useLangName();
  const [v, setV] = useState<SttProvider>("whisper");
  const [model, setModel] = useState<WhisperModel | null>(null);
  useEffect(() => { sttProvider().then(setV); if (isTauri) whisperModels().then(([c]) => setModel(c)).catch(() => {}); }, []);
  const better = course && WHISPER_FOR[course.iso];
  return (
    <div className="card od-row" style={gap("12px")}>
      <span className="od-field od-fill"><b>{t("settings.stt")}</b><span className="muted small">{t(v === "deepgram" ? "settings.sttDeepgram" : "settings.sttWhisper")}</span>
        {v === "whisper" && better && model && model !== better &&
          <span className="small" style={{ color: "var(--orange)" }}>{t("voice.whisperFor", { lang: langName(course.iso), name: t(`voice.whisper${cap(better)}`) })}</span>}</span>
      <HelpButton topic="mic" />
      <button className="btn btn-ghost" onClick={() => openSheet(<SttSheet initial={v} onChange={setV} />)}>{t("settings.change")}</button>
    </div>
  );
}

const STT = [
  { p: "whisper", icon: "lock", color: "var(--green)" },
  { p: "deepgram", icon: "bolt", color: "var(--blue)" },
] as const;
const sttName = (p: SttProvider) => (p === "deepgram" ? "settings.sttDeepgram" : "settings.sttWhisper");

// Picking saves. Deepgram needs its key first: without one, picking it opens the key sheet; with one, the gear edits it.
function SttSheet({ initial, onChange }: { initial: SttProvider; onChange: (v: SttProvider) => void }) {
  const { t } = useTranslation();
  const { toast, openSheet, closeSheet } = useApp();
  const [v, setV] = useState(initial);
  const [hasKey, setHasKey] = useState(false);
  useEffect(() => { getDeepgramKey().then((k) => setHasKey(!!k)).catch(() => {}); }, []);
  const back = () => openSheet(<SttSheet initial={v} onChange={onChange} />);
  const configure = () => openSheet(<DeepgramSheet onSaved={() => { onChange("deepgram"); openSheet(<SttSheet initial="deepgram" onChange={onChange} />); }} onCancel={back} />);
  const pick = async (next: SttProvider) => {
    if (next === v) return;
    if (next === "deepgram" && !hasKey) return configure();
    await setSetting("stt", next);
    resetSttReady();
    setV(next); onChange(next);
    toast(t("voice.saved"));
  };
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("settings.stt")}</h3>
      <div className="od-stack" style={gap("8px")} role="radiogroup" aria-label={t("settings.stt")}>
        {STT.map(({ p, icon, color }) => (
          <div key={p} className={`voice-option${v === p ? " on" : ""}`}>
            <button role="radio" aria-checked={v === p} onClick={() => pick(p)}>
              <span className="voice-icon" style={{ color }}><Icon name={icon} /></span>
              <span className="od-field od-fill"><b>{t(sttName(p))}</b><span className="muted small">{t(`voice.${p}Good`)}</span></span>
            </button>
            {p === "deepgram" && hasKey && <button className="icon-btn" aria-label={t("voice.configure", { name: "Deepgram" })} onClick={configure}><Icon name="gear" /></button>}
            {p === "whisper" && <button className="icon-btn" aria-label={t("voice.configure", { name: "Whisper" })} onClick={() => openSheet(<WhisperSheet onBack={back} />)}><Icon name="gear" /></button>}
            <InfoTip label={t("voice.about", { name: p === "deepgram" ? "Deepgram" : "Whisper" })}>{t(p === "deepgram" ? "voice.deepgramDesc" : "voice.whisperDesc")}</InfoTip>
          </div>
        ))}
      </div>
      <div className="od-stack sheet-actions" style={gap("8px")}>
        <button className="btn btn-blue btn-block" onClick={() => openSheet(<SttTrySheet provider={v} onBack={back} />)}><Icon name="mic" /> {t("voice.try")}</button>
        <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}

const WHISPER: WhisperModel[] = ["base", "small", "turbo"];
const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
// Course languages the bundled base model hears poorly. Hungarian course sentences (macOS voice) passed the speech
// check 6/18 with base, 8/18 with small and 15/18 with turbo. ponytail: add a language once it is measured.
const WHISPER_FOR: Record<string, WhisperModel> = { hu: "turbo" };

/** Whisper model: the bundled one or a bigger download. Picking one downloads it if needed, then uses it. */
function WhisperSheet({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { toast, course } = useApp();
  const langName = useLangName();
  const better = course && WHISPER_FOR[course.iso];
  const [cur, setCur] = useState<WhisperModel>("base");
  const [have, setHave] = useState<WhisperModel[]>([]);
  const [busy, setBusy] = useState<{ m: WhisperModel; pct: number } | null>(null);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState<WhisperModel | null>(null); // delete asked, waiting for the second tap
  useEffect(() => {
    if (!isTauri) return setErr(t("voice.whisperMissing")); // browser preview: no models to manage
    whisperModels().then(([c, h]) => { setCur(c); setHave(h); }).catch((e) => setErr(String(e)));
  }, []);
  const pick = async (m: WhisperModel) => {
    if (busy || m === cur) return;
    setErr("");
    try {
      if (m !== "base" && !have.includes(m)) {
        setBusy({ m, pct: 0 });
        await downloadWhisper(m, (pct) => setBusy({ m, pct }));
        setHave((h) => [...h, m]);
      }
      await pickWhisper(m);
      setCur(m);
      toast(t("voice.saved"));
    } catch (e) { setErr(String(e)); } // Tauri invoke rejects with strings
    finally { setBusy(null); }
  };
  const remove = async (m: WhisperModel) => {
    if (busy) return;
    setErr(""); setAsk(null);
    try {
      await removeWhisper(m);
      setHave((h) => h.filter((x) => x !== m));
      if (cur === m) setCur("base");
      toast(t("voice.whisperRemoved"));
    } catch (e) { setErr(String(e)); }
  };
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("voice.whisperModel")}</h3>
      <p className="small">{t("voice.whisperModelDesc")}</p>
      {better && cur !== better && <p className="small" style={{ color: "var(--orange)" }}>{t("voice.whisperFor", { lang: langName(course.iso), name: t(`voice.whisper${cap(better)}`) })}</p>}
      <div className="od-stack" style={gap("8px")} role="radiogroup" aria-label={t("voice.whisperModel")}>
        {WHISPER.map((m, i) => (
          <Fragment key={m}>
            <div className={`voice-option${cur === m ? " on" : ""}`}>
              <button role="radio" aria-checked={cur === m} disabled={!!busy || !isTauri} onClick={() => pick(m)}>
                <Signal bars={i + 1} color="var(--green)" />
                <span className="od-field od-fill"><b>{t(`voice.whisper${cap(m)}`)}</b><span className="muted small">{t(`voice.whisper${cap(m)}Good`)}</span></span>
              </button>
              {have.includes(m) && <button className="icon-btn" aria-label={t("voice.whisperRemove", { name: t(`voice.whisper${cap(m)}`) })} disabled={!!busy} onClick={() => setAsk(ask === m ? null : m)}><Icon name="trash" /></button>}
            </div>
            {ask === m && (
              <div className="od-row" style={gap("8px")} role="alert">
                <span className="small od-fill">{t("voice.whisperRemoveAsk", { name: t(`voice.whisper${cap(m)}`) })}</span>
                <button className="btn btn-ghost" onClick={() => setAsk(null)}>{t("sheet.cancel")}</button>
                <button className="btn btn-danger" onClick={() => remove(m)}>{t("profiles.delete")}</button>
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {busy && (
        <div className="od-stack" style={gap("6px")} role="status">
          <div className="progress-track"><div className="progress-fill green" style={{ width: `${Math.round(busy.pct * 100)}%` }} /></div>
          <span className="muted small">{t("voice.downloading", { pct: Math.round(busy.pct * 100) })}</span>
        </div>
      )}
      {err && <p className="small" role="status" style={{ color: "var(--red)", overflowWrap: "anywhere" }}>{err}</p>}
      <button className="btn btn-ghost btn-block" disabled={!!busy} onClick={onBack}>{t("voice.back")}</button>
    </div>
  );
}

/** Tries the saved recognizer: listens until the sheet closes and lists each utterance it heard. */
function SttTrySheet({ provider, onBack }: { provider: SttProvider; onBack: () => void }) {
  const { t } = useTranslation();
  const { course } = useApp();
  const lang = course?.iso ?? "en";
  const [heard, setHeard] = useState<string[]>([]);
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let mic: Listener | undefined, gone = false;
    (async () => {
      // No recognizer still opens the mic, so the level bar shows the mic itself works.
      if (!(await sttReady())) setErr(t(provider === "deepgram" ? "voice.noKey" : "voice.whisperMissing"));
      const l = await listen(lang, {
        level: setLevel,
        speech: () => setSpeaking(true),
        utterance: (x) => { setSpeaking(false); if (!isNoise(x)) setHeard((h) => [...h, x]); },
        error: (e) => { setSpeaking(false); setErr(e.message); },
      });
      if (gone) l.stop(); else mic = l;
    })().catch((e) => setErr(e instanceof DOMException ? t("voice.micBlocked", { error: e.message }) : (e as Error).message)); // DOMException: getUserMedia
    return () => { gone = true; mic?.stop(); };
  }, [lang, provider]);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); }, [heard]);
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("voice.tryTitle", { name: t(sttName(provider)) })}</h3>
      <div className="od-row" style={gap("10px")} role="status">
        <span className="voice-icon" style={{ color: err ? "var(--text-faint)" : "var(--red)" }}><Icon name="mic" /></span>
        <div className="progress-track od-fill"><div className="progress-fill green" style={{ width: `${Math.min(100, Math.round(level * 800))}%`, transition: "none" }} /></div>
      </div>
      <span className="muted small">{t(speaking ? "voice.hearing" : "voice.tryHint")}</span>
      <div ref={list} className="stt-heard">
        {heard.length ? heard.map((x, i) => <p key={i}>{x}</p>) : <p className="muted small">{t("voice.nothingYet")}</p>}
      </div>
      {err && <p className="small" role="status" style={{ color: "var(--red)", overflowWrap: "anywhere" }}>{err}</p>}
      <button className="btn btn-ghost btn-block" onClick={onBack}>{t("voice.back")}</button>
    </div>
  );
}

/** The Deepgram key: test it, then save it and switch speech recognition to Deepgram. */
function DeepgramSheet({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { toast } = useApp();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { getDeepgramKey().then((k) => setKey(k ?? "")).catch(() => {}); }, []);

  const test = async () => {
    setBusy(true); setStatus(null);
    try {
      await deepgramTranscribe(wav16(new Float32Array(8000)), "en", key.trim()); // 0.5 s of silence
      setStatus({ ok: true, msg: t("voice.connected") });
    } catch (e) { setStatus({ ok: false, msg: `${t("ai.connectFailed")}: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await setDeepgramKey(key.trim());
      await setSetting("stt", "deepgram");
      resetSttReady();
      toast(t("voice.saved"));
      onSaved();
    } catch (e) { setStatus({ ok: false, msg: (e as Error).message }); setBusy(false); }
  };
  return (
    <div className="od-stack" style={sheet}>
      <h3 style={{ textAlign: "center" }}>{t("settings.sttDeepgram")}</h3>
      <p className="small">{t("voice.deepgramDesc")}</p>
      <label className="od-field"><b>{t("voice.deepgramKey")}</b><span className="muted small">{t("ai.apiKeyDesc")}</span>
        <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      {status && <p className="small" role="status" style={{ color: status.ok ? "var(--green)" : "var(--red)", overflowWrap: "anywhere" }}>{status.msg}</p>}
      <div className="od-stack sheet-actions" style={gap("8px")}>
        <div className="od-row" style={gap("8px")}>
          <button className="btn btn-ghost" disabled={busy || !key.trim()} onClick={test}>{t("ai.test")}</button>
          <button className="btn btn-primary od-fill" disabled={busy || !key.trim()} onClick={save}>{t("ai.save")}</button>
        </div>
        <button className="btn btn-ghost btn-block" onClick={onCancel}>{t("sheet.cancel")}</button>
      </div>
    </div>
  );
}
