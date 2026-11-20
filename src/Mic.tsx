import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { startRecording, sttReady, type Recording } from "./stt";
import { useApp } from "./store";
import { type Utterance } from "./speech";
import { HelpButton } from "./Help";

/** Why speaking is unavailable (i18n key), or null when it can be used: needs the bundled model and the Settings switch. */
export function useSpeakBlock() {
  const { s } = useApp();
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => { sttReady().then(setReady); }, []);
  return ready === false ? "stt.unavailable" : !s.speakOn ? "stt.off" : null;
}

/** Tap to talk, tap again to stop (design: round blue button + status line). Calls `onText` with the transcript. */
export function MicButton({ lang, onText, disabled, trigger = 0, native }: { lang: string; onText: (text: string, m?: Utterance) => void; disabled?: boolean; trigger?: number; native?: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "starting" | "rec" | "busy">("idle");
  const player = useRef<HTMLAudioElement | null>(null);
  const [err, setErr] = useState("");
  const rec = useRef<Recording | undefined>(undefined);
  const [take, setTake] = useState<string>(); // blob URL of the last recording
  useEffect(() => () => { if (take) URL.revokeObjectURL(take); }, [take]);

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = undefined;
    setState("busy");
    try { const r2 = await r.stop(); setTake(r2.audio); onText(r2.text, r2.m); }
    catch (e) { setErr(`${t("stt.failed")}: ${(e as Error).message ?? e}`); }
    finally { setState("idle"); }
  };
  const toggle = async () => {
    if (state === "rec") return stop();
    if (state !== "idle") return;
    setErr("");
    setState("starting");
    try { rec.current = await startRecording(lang, stop, native); setState("rec"); }
    catch { setErr(t("stt.noMic")); setState("idle"); }
  };
  useEffect(() => () => { rec.current?.stop(false); }, []);
  // Keyboard: each bump of `trigger` presses the button.
  // Starts at the mount value so a leftover count from an earlier speak item does not press it on mount.
  const seen = useRef(trigger);
  useEffect(() => { if (trigger !== seen.current) { seen.current = trigger; if (!disabled) toggle(); } }, [trigger]);

  return (
    <div className="mic-wrap">
      <button className={`mic-btn ${state}`} onClick={toggle} disabled={disabled || state === "busy" || state === "starting"} aria-pressed={state === "rec"}
        aria-label={t(state === "rec" ? "stt.stop" : "stt.record")}><Icon name="mic" /></button>
      <p className="muted small" role="status" style={{ textAlign: "center", color: err ? "var(--red)" : undefined }}>{err || t(`stt.${state}`)}</p>
      {take && state === "idle" && <div style={{ display: "flex", justifyContent: "center" }}>
        <button className="prompt-word" onClick={() => {
          const a = player.current ?? (player.current = new Audio());
          if (a.src !== take) { a.src = take; a.load(); }
          a.currentTime = 0;
          a.play().catch(() => { a.load(); void a.play().catch(() => {}); });
        }}><Icon name="headphones" /> {t("stt.playback")}</button>
      </div>}
      {err && <div style={{ display: "flex", justifyContent: "center" }}><HelpButton topic="mic" /></div>}
    </div>
  );
}
