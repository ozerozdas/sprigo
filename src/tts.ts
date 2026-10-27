// Text-to-speech: system voices, local Piper (every course language), local Kokoro (English only), ElevenLabs (cloud) or a local speech server; the last two desktop only.
// Device setting "tts" ("tts.phone" on the phone): "system" | "piper" | "kokoro" | "elevenlabs" | "local". Piper and Kokoro run in workers (src/piper.worker.ts, src/kokoro.worker.ts)
// and stream one sentence at a time, so the first sentence plays while the rest is made. ElevenLabs and a local OpenAI-compatible
// speech server ("local", e.g. Kokoro-FastAPI) return the whole line as MP3.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getSetting, isCompanion, isTauri } from "./db";
import { ELEVEN_VOICES, LOCAL_TTS, elevenRequest, localRequest, type ByteRequest, type LocalTts } from "./ttsCloud";
import { pickSystemVoice } from "./voices";
import { mouthBright, mouthLevel, remember, zcr } from "./audio";

export type Voice = { gender: "f" | "m"; kokoro?: string };
export type TtsProvider = "system" | "piper" | "kokoro" | "elevenlabs" | "local";
type Engine = "piper" | "kokoro"; // the worker engines
type Chunk = { audio: Float32Array; rate: number };
type Msg = { type: string; id?: number; p?: number; message?: string; voice?: string } & Partial<Chunk>;

// The phone shares the desktop's database but has its own voice: Kokoro runs out of memory in iOS Safari (docs/MOBILE.md §3).
export const TTS_KEY = isCompanion ? "tts.phone" : "tts";
export const ttsProvider = async (): Promise<TtsProvider> => {
  const v = await getSetting(TTS_KEY);
  return ((v === "kokoro" || v === "elevenlabs" || v === "local") && !isCompanion) || v === "piper" ? v : "system";
};

// ponytail: the dev browser preview has no keychain, so it keeps the key in localStorage. Never used in the app.
const DEV_KEY = "sprigo.devkey.elevenlabs";
export const getElevenKey = () => (isTauri ? invoke<string | null>("secret_get", { key: "tts-key.elevenlabs" }) : Promise.resolve(localStorage.getItem(DEV_KEY)));
export async function setElevenKey(value: string | null) {
  if (isTauri) return invoke("secret_set", { key: "tts-key.elevenlabs", value });
  value ? localStorage.setItem(DEV_KEY, value) : localStorage.removeItem(DEV_KEY);
}
/** The learner's ElevenLabs voice ids (device settings "tts.eleven.voice.f/m"), else the defaults. */
export const elevenVoice = async (gender: "f" | "m" = "f") => (await getSetting(`tts.eleven.voice.${gender}`)) || ELEVEN_VOICES[gender];
/** The local speech server (device setting "tts.local"). */
export const localTts = async (): Promise<LocalTts> => ({ ...LOCAL_TTS, ...JSON.parse((await getSetting("tts.local")) ?? "{}") });
const http = (isTauri ? tauriFetch : window.fetch.bind(window)) as typeof fetch;

// ponytail: one voice per language and gender; Turkish has no female Piper voice, dfki is the closest
const PIPER: Record<string, Record<"f" | "m", string>> = {
  en: { f: "en_US-hfc_female-medium", m: "en_US-hfc_male-medium" },
  de: { f: "de_DE-kerstin-low", m: "de_DE-thorsten-medium" },
  fr: { f: "fr_FR-siwis-medium", m: "fr_FR-tom-medium" },
  es: { f: "es_ES-sharvard-medium", m: "es_ES-davefx-medium" },
  tr: { f: "tr_TR-dfki-medium", m: "tr_TR-fahrettin-medium" },
  hu: { f: "hu_HU-anna-medium", m: "hu_HU-imre-medium" },
};
// Accents (#35): where an engine has a voice for one, it is used; elsewhere the language's default voice speaks.
const PIPER_ACCENT: Record<string, Record<"f" | "m", string>> = { "en-GB": { f: "en_GB-cori-medium", m: "en_GB-alan-medium" } };
const KOKORO_ACCENT: Record<string, Record<"f" | "m", string>> = { "en-GB": { f: "bf_emma", m: "bm_george" } };
const piperVoice = (lang: string, gender: "f" | "m" = "f", accent?: string) => (accent && PIPER_ACCENT[accent]?.[gender]) || PIPER[lang.slice(0, 2)]?.[gender];

/** Speech speed, device setting "tts.speed": ElevenLabs' 0.7–1.2, so every engine takes the same range. `slow` is the slow replay. */
export const SPEED = { min: 0.7, max: 1.2, slow: 0.7 };
export const ttsSpeed = async () => { const v = Number(await getSetting("tts.speed")); return v >= SPEED.min && v <= SPEED.max ? v : 1; };
/** The accents a course language offers (device setting "tts.accent.<lang>"); unset = the engines' default voice. */
// ponytail: English only; Piper's two es-MX voices don't say which is female, add es-MX when one is known
export const ACCENTS: Record<string, string[]> = { en: ["en-US", "en-GB"] };
export const ttsAccent = async (lang: string) => {
  const code = lang.slice(0, 2), v = await getSetting(`tts.accent.${code}`);
  return v && ACCENTS[code]?.includes(v) ? v : undefined;
};
/** Can `p` speak `lang`? Kokoro is English only, Piper has the voices above; the rest are assumed to (they fall back if not). */
export const ttsSpeaks = (p: TtsProvider, lang: string) => (p === "kokoro" ? lang.startsWith("en") : p === "piper" ? !!piperVoice(lang) : true);

/** The engine and its voice for this language, or null for the system voice. */
async function engineFor(lang: string, voice?: Voice, p?: TtsProvider, accent?: string): Promise<[Exclude<TtsProvider, "system">, string] | null> {
  p ??= await ttsProvider();
  if (p === "elevenlabs") return ["elevenlabs", await elevenVoice(voice?.gender)];
  if (p === "local") return ["local", JSON.stringify(await localTts())];
  if (p === "kokoro" && lang.startsWith("en")) {
    const g = voice?.gender ?? "f", region = accent && KOKORO_ACCENT[accent];
    // A character's own Kokoro voice stays when it already has the accent (its first letter: a = American, b = British).
    return ["kokoro", region ? (voice?.kokoro?.[0] === region.f[0] ? voice.kokoro : region[g]) : voice?.kokoro ?? (g === "m" ? "am_michael" : "af_heart")];
  }
  const v = p === "piper" && piperVoice(lang, voice?.gender, accent);
  return v ? ["piper", v] : null;
}

const workers: Partial<Record<Engine, Worker>> = {};
const loadListeners: Record<Engine, Set<(m: Msg) => void>> = { kokoro: new Set(), piper: new Set() };
let pending: { id: number; msg: (m: Msg) => void; cancel: () => void } | undefined; // the one speak a worker is working on

function worker(e: Engine) {
  let w = workers[e];
  if (!w) {
    w = workers[e] = e === "kokoro"
      ? new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" })
      : new Worker(new URL("./piper.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data: m }: MessageEvent<Msg>) => {
      if (m.id === undefined) loadListeners[e].forEach((f) => f(m));
      else if (m.id === pending?.id) pending.msg(m);
    };
    w.onerror = (ev) => {
      const m = { type: "error", message: ev.message || `${e} worker failed` };
      loadListeners[e].forEach((f) => f(m));
      pending?.msg({ ...m, id: pending.id });
    };
  }
  return w;
}

const loads = new Map<string, Promise<void>>();
/** Loads (downloads on first use, then cached) an engine's model; `onProgress` gets 0..1 of the first load. */
function load(e: Engine, voice: string, onProgress: (p: number) => void = () => {}) {
  const key = `${e}:${voice}`;
  // Piper tags its messages with the voice, so two voices loading at once don't answer each other.
  const mine = (m: Msg) => m.voice === undefined || m.voice === voice;
  const progress = (m: Msg) => { if (m.type === "progress" && mine(m)) onProgress(m.p!); };
  loadListeners[e].add(progress);
  let p = loads.get(key);
  if (!p) {
    p = new Promise<void>((ok, no) => {
      const f = (m: Msg) => {
        if (!mine(m)) return;
        if (m.type === "ready") { loadListeners[e].delete(f); ok(); }
        else if (m.type === "error") { loadListeners[e].delete(f); no(new Error(m.message)); }
      };
      loadListeners[e].add(f);
      worker(e).postMessage({ type: "load", voice });
    }).catch((err) => { loads.delete(key); throw err; });
    loads.set(key, p);
  }
  return p.finally(() => loadListeners[e].delete(progress));
}

export const loadKokoro = (onProgress?: (p: number) => void) => load("kokoro", "", onProgress);
/** Loads the Piper voice for a language (the female one unless told otherwise). */
export const loadPiper = async (lang: string, onProgress?: (p: number) => void, gender?: "f" | "m") =>
  load("piper", piperVoice(lang, gender, await ttsAccent(lang)) ?? PIPER.en.f, onProgress);

/** Starts loading the local voice this language will use, so the first line is not waiting on the model. */
export async function prewarm(lang: string, voice?: Voice) {
  const got = await engineFor(lang, voice, undefined, await ttsAccent(lang));
  if (got && (got[0] === "piper" || got[0] === "kokoro")) await load(got[0], got[0] === "kokoro" ? "" : got[1]);
}

let seq = 0;
let sources: AudioBufferSourceNode[] = [];
let actx: AudioContext | undefined;
let analyser: AnalyserNode | undefined; // local-engine audio passes through it so faces can read the loudness
const out = (ctx: AudioContext) => {
  if (!analyser) { analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.connect(ctx.destination); }
  return analyser;
};
let next = 0; // when the queued sentences end, in AudioContext time
let finish = () => {}; // resolves the current speak()
const cache = new Map<string, Chunk[]>();

/** Silences whatever is speaking (and drops local-engine sentences still being generated). */
export function stopSpeaking() {
  seq++;
  speechSynthesis.cancel();
  for (const s of sources) try { s.stop(); } catch { /* already ended */ }
  sources = [];
  prep(null);
  if (pending) { pending.cancel(); pending = undefined; Object.values(workers).forEach((w) => w.postMessage({ type: "cancel" })); }
  finish();
}

/** The system voice list, which browsers fill in after startup: an empty first answer would mean the default (often female) voice. */
function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((ok) => {
    const got = () => { clearTimeout(t); speechSynthesis.removeEventListener("voiceschanged", got); ok(speechSynthesis.getVoices()); };
    const t = setTimeout(got, 1500);
    speechSynthesis.addEventListener("voiceschanged", got);
  });
}

let onStart: ((at: number) => void) | undefined; // the current speak's `started`
const begun = (at = performance.now()) => { prep(null); const f = onStart; onStart = undefined; f?.(at); };

// The line a speak is still getting ready (voice model loading, first sentence being made); null once audio starts or it ends.
let preparing: string | null = null;
const prepSubs = new Set<() => void>();
const prep = (text: string | null) => { if (preparing !== text) { preparing = text; prepSubs.forEach((f) => f()); } };
/** Listen buttons: true while `text` waits on its voice, so they look busy and a second click does nothing. */
export const useTtsPreparing = (text: string) =>
  useSyncExternalStore((f) => { prepSubs.add(f); return () => { prepSubs.delete(f); }; }, () => preparing) === text;

async function system(text: string, lang: string, gender: "f" | "m" | undefined, mine: number, done: () => void, speed: number, accent?: string) {
  const voices = await systemVoices();
  if (mine !== seq) return; // cut while waiting
  const u = new SpeechSynthesisUtterance(text);
  u.lang = accent ?? lang;
  const { voice, pitch } = pickSystemVoice(voices, lang, gender, accent);
  if (voice) u.voice = voice;
  u.pitch = pitch;
  u.rate = speed;
  u.onstart = () => begun();
  u.onend = u.onerror = done;
  speechSynthesis.speak(u);
}

/** Queues chunks back to back through the analyser; `end()` once no more will come, then `done` runs when the last one has played. */
function player(ctx: AudioContext, mine: number, done: () => void) {
  next = 0;
  let left = 0, streaming = true, first = true;
  const play = (c: Chunk) => {
    if (mine !== seq) return;
    const buf = ctx.createBuffer(1, c.audio.length, c.rate);
    buf.copyToChannel(c.audio as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out(ctx));
    const at = Math.max(ctx.currentTime, next);
    next = at + buf.duration;
    left++;
    if (first) { first = false; begun(performance.now() + (at - ctx.currentTime) * 1000); }
    src.onended = () => { if (--left === 0 && !streaming) done(); };
    sources.push(src);
    src.start(at);
  };
  const end = () => { streaming = false; if (left === 0) done(); };
  return { play, end };
}

const audioCtx = async (mine: number) => {
  const ctx = (actx ??= new AudioContext());
  await ctx.resume();
  return mine === seq ? ctx : null; // null: cut while waiting; `next` belongs to the newer speak now
};

/** Plays local-engine audio for `text`; resolves once the first sentence plays, throws before that to fall back. */
async function viaWorker(e: Engine, text: string, voice: string, mine: number, done: () => void, speed: number) {
  const key = `${e}:${voice}:${speed}\n${text}`;
  const ctx = await audioCtx(mine);
  if (!ctx) return;
  const { play, end } = player(ctx, mine, done);
  const hit = cache.get(key);
  if (hit) { remember(cache, key, hit); hit.forEach(play); end(); return; }

  const loading = load(e, e === "kokoro" ? "" : voice);
  // A Piper voice not downloaded yet keeps downloading, but this line falls back to the system voice.
  if (e === "piper" && !(await Promise.race([loading.then(() => true), new Promise((ok) => setTimeout(ok, 5000, false))]))) throw new Error(STILL_LOADING);
  if (mine !== seq) return;
  const got: Chunk[] = [];
  await new Promise<void>((started, failed) => {
    const timer = setTimeout(() => { pending = undefined; failed(new Error(`${e} timed out`)); }, 30_000);
    pending = {
      id: mine,
      cancel: () => { clearTimeout(timer); started(); },
      msg: (m) => {
        if (m.type === "chunk") { clearTimeout(timer); got.push(m as Chunk); play(m as Chunk); started(); }
        else if (m.type === "end" || m.type === "error") {
          clearTimeout(timer);
          pending = undefined;
          if (m.type === "end") remember(cache, key, got); // ponytail: 20 lines kept, oldest dropped
          if (got.length) { end(); started(); } else failed(new Error(m.message ?? `${e} made no audio`));
        }
      },
    };
    worker(e).postMessage({ type: "speak", id: mine, text, voice, speed });
  });
}

/** Plays one line an HTTP engine returns as an audio file (MP3); throws before any audio to fall back. */
async function viaBytes(cacheKey: string, req: () => Promise<ByteRequest>, mine: number, done: () => void) {
  const ctx = await audioCtx(mine);
  if (!ctx) return;
  const { play, end } = player(ctx, mine, done);
  let hit = cacheKey.startsWith("test:") ? undefined : cache.get(cacheKey); // a test must reach the server
  if (!hit) {
    const { url, headers, body } = await req();
    const r = await http(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    hit = [{ audio: buf.getChannelData(0), rate: buf.sampleRate }];
  }
  remember(cache, cacheKey, hit);
  if (mine !== seq) return;
  hit.forEach(play);
  end();
}

const elevenLine = (text: string, lang: string, voice: string, key?: string, speed = 1) => () =>
  (key ? Promise.resolve(key) : getElevenKey()).then((k) => {
    if (!k) throw new Error("No ElevenLabs key");
    return elevenRequest(k, voice, text, lang, speed);
  });

/** Settings' test for the local server: no fallback, so an unreachable server throws; resolves once audio starts. */
export async function sayWithLocal(text: string, c: LocalTts) {
  stopSpeaking();
  await viaBytes(`test:local\n${text}`, async () => localRequest(c, text), seq, () => {});
}

/** Settings' test: speaks with this key and voice, no fallback, so a bad key throws; resolves once audio starts. */
export async function sayWithEleven(text: string, lang: string, key: string, voice: string) {
  stopSpeaking();
  await viaBytes(`test:${voice}\n${text}`, elevenLine(text, lang, voice, key), seq, () => {});
}

// ---- Which engine spoke, and one notice per session when the chosen one fell back to the system voice ----
let lastEngine: TtsProvider | null = null; // null: nothing spoken yet
export const speakingWith = () => lastEngine;
const fallbackSubs = new Set<() => void>();
let noticed = false;
/** Calls `cb` the first time a line falls back to the system voice since `resetTtsNotice`; returns the unsubscribe. */
export function onTtsFallback(cb: () => void) { fallbackSubs.add(cb); return () => { fallbackSubs.delete(cb); }; }
export const resetTtsNotice = () => { noticed = false; };
const fellBack = () => { if (!noticed) { noticed = true; fallbackSubs.forEach((f) => f()); } };
const STILL_LOADING = "Piper voice still loading"; // a first download: the next lines use it, not worth a notice

/** One voice at a time: a new call cuts the previous one. Resolves when this speech ends or is cut.
 *  Falls back to the system voice if the local engine fails before any audio. `started` gets the time its audio begins.
 *  `speed` overrides the learner's setting (the slow replay). */
export async function speak(text: string, lang: string, voice?: Voice, started?: (at: number) => void, speed?: number): Promise<void> {
  stopSpeaking();
  onStart = started;
  const mine = seq;
  prep(text);
  let done!: () => void;
  const over = new Promise<void>((ok) => { done = () => { if (mine === seq) prep(null); ok(); }; });
  finish = done;
  const [want, rate, accent] = await Promise.all([ttsProvider(), speed ?? ttsSpeed(), ttsAccent(lang)]);
  const local = await engineFor(lang, voice, want, accent);
  if (local) {
    try {
      lastEngine = local[0];
      if (local[0] === "elevenlabs") await viaBytes(`elevenlabs:${local[1]}:${rate}\n${text}`, elevenLine(text, lang, local[1], undefined, rate), mine, done);
      else if (local[0] === "local") await viaBytes(`local:${local[1]}:${rate}\n${text}`, async () => localRequest(JSON.parse(local[1]), text, rate), mine, done);
      else await viaWorker(local[0], text, local[1], mine, done, rate);
      return over;
    } catch (e) {
      console.error(e);
      if ((e as Error).message !== STILL_LOADING) fellBack();
    }
  } else if (want !== "system") fellBack(); // e.g. Kokoro or Piper has no voice for this language
  lastEngine = "system";
  if (mine !== seq) return over;
  await system(text, lang, voice?.gender, mine, done, rate, accent);
  return over;
}

// ---- Mouth: how open a talking face's mouth is (0..1) and its shape (0 round .. 1 wide), every animation frame ----
const mouthSubs = new Set<(open: number, bright: number) => void>();
const frame = new Float32Array(1024);
let raf = 0, lastT = 0, level = 0, bright = 0;

function tick(t: number) {
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  let rms = 0, rate = 0;
  // The system voice gives no audio to measure: uneven pseudo-syllables (three beats that drift in and out of step) instead of a metronome.
  if (speechSynthesis.speaking) {
    const s = t / 1000, beat = Math.sin(2 * Math.PI * 3.1 * s) * 0.6 + Math.sin(2 * Math.PI * 4.7 * s) * 0.4;
    rms = 0.02 + 0.2 * Math.max(0, beat) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * s));
    rate = 0.03 + 0.07 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.9 * s));
  } else if (analyser) {
    analyser.getFloatTimeDomainData(frame);
    rms = Math.sqrt(frame.reduce((n, x) => n + x * x, 0) / frame.length);
    rate = zcr(frame);
  }
  level = mouthLevel(level, rms, dt);
  if (rms > 0.03) bright = mouthBright(bright, rate, dt); // silence is noisy, keep the last vowel's shape
  raf = requestAnimationFrame(tick); // before the callbacks, so one that throws can't stop the loop
  mouthSubs.forEach((f) => f(level, bright));
}

/** Calls `cb` with the mouth openness and shape every frame until the returned function is called. */
export function onMouth(cb: (open: number, bright: number) => void) {
  mouthSubs.add(cb);
  if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); }
  return () => {
    mouthSubs.delete(cb);
    if (!mouthSubs.size) { cancelAnimationFrame(raf); raf = 0; level = 0; bright = 0; }
  };
}
