// Speech-to-text (DECISIONS D2): microphone in the webview, bundled whisper.cpp in Rust (src-tauri/src/lib.rs).
import { mark } from "./latency";
import { Channel, invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri, isCompanion, getSetting } from "./db";
import { VAD, VAD_IDLE, concat, resample, rms, vadStep, type VadEvent } from "./audio";
import { wav16 } from "./wav";
import { speechMetrics, type Utterance } from "./speech";

export type SttProvider = "whisper" | "deepgram";
export const sttProvider = async (): Promise<SttProvider> => ((await getSetting("stt")) === "deepgram" ? "deepgram" : "whisper");

// ponytail: the dev browser preview has no keychain, so it keeps the key in localStorage. Never used in the app.
const DEV_KEY = "sprigo.devkey.deepgram";
export const getDeepgramKey = () => (isTauri ? invoke<string | null>("secret_get", { key: "stt-key.deepgram" }) : Promise.resolve(localStorage.getItem(DEV_KEY)));
export async function setDeepgramKey(value: string | null) {
  if (isTauri) return invoke("secret_set", { key: "stt-key.deepgram", value });
  value ? localStorage.setItem(DEV_KEY, value) : localStorage.removeItem(DEV_KEY);
}

const http = (isTauri ? tauriFetch : window.fetch.bind(window)) as typeof fetch;
/** Deepgram nova-3 transcript of a 16 kHz WAV; throws with the server's message on HTTP errors. */
export async function deepgramTranscribe(wav: Uint8Array, lang: string, key?: string | null): Promise<string> {
  key ??= await getDeepgramKey();
  if (!key) throw new Error("No Deepgram key");
  const r = await http(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=${encodeURIComponent(lang.slice(0, 2))}`, {
    method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" }, body: wav as BodyInit,
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

/** Whisper model sizes (src-tauri/src/lib.rs `stt_file`): "base" ships with the app, the others are downloaded on demand. */
export type WhisperModel = "base" | "small" | "turbo" | "large";
/** [model in use, downloaded models] */
export const whisperModels = () => invoke<[WhisperModel, WhisperModel[]]>("stt_models");
export const pickWhisper = (name: WhisperModel) => invoke("stt_use", { name });
export const removeWhisper = (name: WhisperModel) => invoke("stt_remove", { name });
export function downloadWhisper(name: WhisperModel, onProgress: (p: number) => void) {
  const progress = new Channel<number>();
  progress.onmessage = onProgress;
  return invoke("stt_download", { name, progress });
}

let ready: Promise<boolean> | undefined;
/** Speaking available? Deepgram: key present. Whisper: model present in this build (always false in the browser preview). */
export const sttReady = () => (ready ??= (async () => {
  if ((await sttProvider()) === "deepgram") return !!(await getDeepgramKey().catch(() => null));
  return isTauri ? invoke<boolean>("stt_ready").catch(() => false) : isCompanion;
})());
/** Call after the provider or the key changes. */
export const resetSttReady = () => { ready = undefined; };

export const MAX_RECORD_S = 15;

/** Starts recording; `stop()` returns the transcript (`stop(false)` just releases the mic). Auto-stops after MAX_RECORD_S (onAutoStop fires).
 *  With `native` the transcript also gets its speech signals; there is no tutor turn to time, so `latencyMs` is null. */
export async function startRecording(lang: string, onAutoStop?: () => void, native?: string) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ponytail: ScriptProcessor is deprecated but works everywhere without a worklet file
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  const timer = setTimeout(() => onAutoStop?.(), MAX_RECORD_S * 1000);
  let stopped = false;
  return {
    async stop(transcribe = true): Promise<{ text: string; m?: Utterance }> {
      if (stopped) return { text: "" };
      stopped = true;
      clearTimeout(timer);
      proc.disconnect(); src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const rate = ctx.sampleRate;
      await ctx.close();
      if (!transcribe) return { text: "" };
      const all = concat(chunks), text = await transcribeSamples(all, rate, lang);
      return { text, m: native && text ? speechMetrics(all, rate, text, { latencyMs: null }, native, lang) : undefined };
    },
  };
}
export type Recording = Awaited<ReturnType<typeof startRecording>>;

/** Transcript of raw mic samples at `rate` Hz; under 0.3 s counts as nothing said. */
async function transcribeSamples(all: Float32Array, rate: number, lang: string): Promise<string> {
  if (all.length < rate * 0.3) return "";
  if ((await sttProvider()) === "deepgram") return deepgramTranscribe(wav16(resample(all, rate)), lang);
  if (isCompanion) { // phone: the desktop's whisper (src-tauri/src/companion.rs), raw f32 samples
    const r = await fetch(`/transcribe?lang=${encodeURIComponent(lang)}`, { method: "POST", headers: { "X-Sprigo": "1" }, body: resample(all, rate) as BodyInit });
    if (!r.ok) throw new Error(await r.text());
    return r.text();
  }
  // ponytail: samples go over IPC as JSON numbers (~1 MB for 15 s); raw bytes if it ever feels slow
  return invoke<string>("transcribe", { samples: Array.from(resample(all, rate)), lang });
}

/** `pause(true)`: the tutor is talking but the learner may cut in (SPR-17); only clearly louder, longer speech counts. */
export type Listener = { pause(bargeIn?: boolean): void; resume(): void; stop(): Promise<void> };
// ponytail: 3× threshold, 300 ms start, guessed; raise if the tutor's own voice through the speakers still cuts her off
const STRICT = { ...VAD, threshold: VAD.threshold * 3, startMs: 300 };

/** Hands-free listening (tutor call): the voice detector cuts the mic stream into utterances and each one is transcribed.
 *  With `native` each utterance also gets its speech signals (SPR-25), measured here so the phone companion gets them too. */
export async function listen(lang: string, on: { utterance: (text: string, m?: Utterance) => void; speech?: () => void; level?: (rms: number) => void; error?: (e: Error) => void }, native?: string): Promise<Listener> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  void ctx.resume(); // created after an await, so it may start suspended
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1); // ponytail: same deprecated node as startRecording
  let v = VAD_IDLE, e: VadEvent, paused = false, strict = false, stopped = false, pre: Float32Array[] = [], chunks: Float32Array[] = [];
  // When the mic re-opened after the tutor spoke; the first utterance after it gets the reply latency.
  // ponytail: measured from resume(), which TutorCall delays 400 ms past the tutor's last word, so it reads ~400 ms short.
  let armed: number | null = null, latency: number | null = null;
  const reset = () => { v = VAD_IDLE; pre = []; chunks = []; };
  proc.onaudioprocess = (ev) => {
    if (paused) return;
    const d = new Float32Array(ev.inputBuffer.getChannelData(0));
    const r = rms(d);
    on.level?.(r);
    [v, e] = vadStep(v, r, (d.length / ctx.sampleRate) * 1000, strict ? STRICT : VAD);
    if (e === "start") {
      chunks = [...pre]; on.speech?.();
      latency = armed === null ? null : Math.max(0, performance.now() - armed - VAD.startMs); armed = null;
    }
    if (v.speaking || e === "end") chunks.push(d);
    else { pre.push(d); if (pre.length > 3) pre.shift(); } // ~250 ms before the detector fired, so the first syllable is kept
    if (e !== "end") return;
    mark("vad");
    const all = concat(chunks), rate = ctx.sampleRate, timing = { latencyMs: latency };
    reset();
    transcribeSamples(all, rate, lang).then(
      (x) => { mark("stt"); if (!stopped) on.utterance(x.trim(), native ? speechMetrics(all, rate, x, timing, native, lang) : undefined); }, // empty too: the caller re-arms its silence timer
      (x) => { if (!stopped) on.error?.(x instanceof Error ? x : new Error(String(x))); }, // Tauri invoke rejects with strings
    );
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  return {
    pause(bargeIn = false) { armed = null; if (bargeIn) { strict = true; return; } paused = true; reset(); on.level?.(0); },
    resume() { paused = strict = false; armed = performance.now(); },
    async stop() {
      if (stopped) return;
      stopped = paused = true;
      proc.disconnect(); src.disconnect();
      stream.getTracks().forEach((x) => x.stop());
      await ctx.close();
    },
  };
}
