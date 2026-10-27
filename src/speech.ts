// Speech signals (SPR-25): fluency and hesitation per utterance, from the mic samples and the transcript. No model, no stored audio.
// Pure module, tested by src/speech.test.ts; measured in listen() (src/stt.ts), saved per call in src/db.ts.
import { VAD, rms } from "./audio.ts"; // .ts: node --test runs this file directly

export type Utterance = {
  latencyMs: number | null; // from the tutor going quiet to the learner starting; null when they spoke again without being prompted
  speechMs: number; // first to last voiced window
  words: number; wpm: number;
  pauseRatio: number; // share of speechMs spent in pauses of MIN_PAUSE_MS or more
  longPauses: number; // quiet stretches over LONG_PAUSE_MS
  level: number; // mean RMS of the voiced windows; only compare against the learner's own average (mics differ)
  fillers: number;
  nativeWords: number; // words in the learner's own language (L1 fallback)
};

const WIN_MS = 20;
export const MIN_PAUSE_MS = 250; // the usual silent-pause cut-off in fluency research
export const LONG_PAUSE_MS = 1000;

// ponytail: common fillers and small native-word lists; whisper drops many fillers, so counts are a floor, not a total.
const FILLERS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "hmm", "mm", "eh", "ee", "eee", "ıı", "ııı", "şey", "äh", "ähm", "öh", "euh", "bah", "este", "pues", "ehm", "cioè", "tipo", "né", "ö", "öö", "ööö", "izé"]);
const COMMON: Record<string, string[]> = {
  en: ["the", "and", "is", "are", "i", "you", "it", "what", "how", "yes", "no", "not", "this", "that", "my", "with", "but", "know"],
  tr: ["ve", "bir", "bu", "ne", "evet", "hayır", "ben", "sen", "değil", "var", "yok", "için", "ama", "nasıl", "çok", "da", "de", "mi", "bilmiyorum"],
  de: ["und", "ich", "ist", "nicht", "das", "die", "der", "ja", "nein", "was", "wie", "du", "ein", "aber", "mit", "weiß"],
  es: ["que", "y", "es", "no", "sí", "yo", "el", "la", "qué", "cómo", "pero", "con", "por", "muy", "sé"],
  fr: ["et", "je", "est", "pas", "oui", "non", "le", "la", "les", "que", "quoi", "comment", "mais", "avec", "très", "sais"],
  it: ["e", "che", "è", "non", "sì", "io", "il", "la", "cosa", "come", "ma", "con", "per", "molto", "so"],
  pt: ["e", "que", "é", "não", "sim", "eu", "o", "a", "como", "mas", "com", "para", "muito", "sei", "você"],
  hu: ["és", "egy", "nem", "igen", "van", "hogy", "én", "ez", "is", "meg", "mit", "nagyon", "csak", "már", "tudom"],
  pl: ["jest", "że", "się", "jak", "ale", "tak", "czy", "mam", "wiem", "bardzo", "jestem", "też", "więc", "dlaczego", "kiedy", "gdzie"],
};
// Natives without Latin letters: any word in their script counts.
const SCRIPT: Record<string, RegExp> = { ru: /\p{Script=Cyrillic}/u, ar: /\p{Script=Arabic}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, ko: /\p{Script=Hangul}/u, zh: /\p{Script=Han}/u };

const tokens = (s: string) => s.toLocaleLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

/** Words that are the learner's own language, not the one they are practising. */
export function nativeCount(words: string[], native: string, target: string): number {
  if (native === target) return 0;
  const script = SCRIPT[native];
  if (script) return SCRIPT[target]?.source === script.source ? 0 : words.filter((w) => script.test(w)).length;
  const mine = new Set(COMMON[native] ?? []), theirs = new Set(COMMON[target] ?? []);
  return words.filter((w) => mine.has(w) && !theirs.has(w)).length;
}

export function speechMetrics(samples: Float32Array, rate: number, transcript: string, timing: { latencyMs: number | null }, native: string, target: string): Utterance {
  const win = Math.max(1, Math.round((rate * WIN_MS) / 1000));
  const voiced: boolean[] = [], levels: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    const r = rms(samples.subarray(i, i + win)), on = r >= VAD.threshold;
    voiced.push(on);
    if (on) levels.push(r);
  }
  const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  let quiet = 0, run = 0, longPauses = 0;
  for (let i = first; first >= 0 && i <= last; i++) {
    if (!voiced[i]) { run++; continue; }
    if (run * WIN_MS >= MIN_PAUSE_MS) quiet += run; // shorter gaps are between words and stop consonants
    if (run * WIN_MS > LONG_PAUSE_MS) longPauses++;
    run = 0;
  }
  const speechMs = first < 0 ? 0 : (last - first + 1) * WIN_MS;
  const all = tokens(transcript), fillers = all.filter((w) => FILLERS.has(w)).length, words = all.length - fillers;
  return {
    latencyMs: timing.latencyMs, speechMs, words,
    wpm: speechMs ? Math.round(words / (speechMs / 60000)) : 0,
    pauseRatio: speechMs ? (quiet * WIN_MS) / speechMs : 0,
    longPauses,
    level: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0,
    fillers, nativeWords: nativeCount(all, native, target),
  };
}

/** One row per call: averages over utterances that said something, counts summed. */
export type SpeechSummary = {
  utterances: number; silences: number; latencyMs: number | null; wpm: number; pauseRatio: number;
  longPauses: number; level: number; fillers: number; words: number; nativeWords: number; speechMs: number;
};
export function summarize(us: Utterance[], silences: number): SpeechSummary {
  const said = us.filter((u) => u.words > 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sum = (k: "longPauses" | "fillers" | "words" | "nativeWords" | "speechMs") => us.reduce((n, u) => n + u[k], 0);
  const lat = said.map((u) => u.latencyMs).filter((x): x is number => x !== null);
  return {
    utterances: said.length, silences, latencyMs: lat.length ? Math.round(avg(lat)) : null,
    wpm: Math.round(avg(said.map((u) => u.wpm))), pauseRatio: avg(said.map((u) => u.pauseRatio)), level: avg(said.map((u) => u.level)),
    longPauses: sum("longPauses"), fillers: sum("fillers"), words: sum("words"), nativeWords: sum("nativeWords"), speechMs: sum("speechMs"),
  };
}

// ---- Live adaptation (SPR-26): the learner's last few answers against their own usual, one hint line for the tutor ----

export type LearnerState = "hesitant" | "flowing" | "struggling" | "l1_fallback" | "neutral";
/** The learner's usual: per answer, from their recent calls (db.speechBaseline) or from earlier in this call. */
export type Baseline = { latencyMs: number | null; wpm: number; pauseRatio: number; words: number };
export const RECENT = 3;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Baseline from earlier answers in this call, for a learner with no past calls yet. */
export function baselineOf(us: Utterance[]): Baseline | null {
  const said = us.filter((u) => u.words > 0);
  return said.length < RECENT ? null : averages(said);
}
function averages(said: Utterance[]): Baseline {
  const lat = said.flatMap((u) => (u.latencyMs === null ? [] : [u.latencyMs]));
  return { latencyMs: lat.length ? mean(lat) : null, wpm: mean(said.map((u) => u.wpm)), pauseRatio: mean(said.map((u) => u.pauseRatio)), words: mean(said.map((u) => u.words)) };
}

/** Rule-based, relative to the learner's own baseline, never a fixed bar: everyone's pace differs.
 *  ponytail: ratios (0.7, 1.4, 1.5, 0.6, 1.1) are first guesses; tune from speech_sessions once there are real calls. */
export function learnerState(us: Utterance[], base: Baseline | null): LearnerState {
  const recent = us.filter((u) => u.words > 0).slice(-RECENT);
  if (recent.length < 2) return "neutral";
  const words = recent.reduce((n, u) => n + u.words, 0), native = recent.reduce((n, u) => n + u.nativeWords, 0);
  if (native / words >= 0.25) return "l1_fallback"; // needs no baseline
  if (!base) return "neutral";
  const r = averages(recent);
  const pr = Math.max(base.pauseRatio, 0.05); // a near-zero usual would make any pause look huge
  if (r.wpm < 0.7 * base.wpm && r.pauseRatio > 1.4 * pr) return "struggling";
  if ((r.latencyMs !== null && base.latencyMs !== null && r.latencyMs > 1.5 * base.latencyMs + 300) || r.words < 0.6 * base.words) return "hesitant";
  if (r.wpm > 1.1 * base.wpm && r.pauseRatio < 0.9 * pr && r.words >= base.words) return "flowing";
  return "neutral";
}

export const STATE_HINTS: Record<Exclude<LearnerState, "neutral">, string> = {
  hesitant: "Learner seems hesitant (slow to answer, short answers). For the next few turns: ask short yes/no or either/or questions, end with a sentence starter in quotes they can finish (e.g. 'I usually…'), praise the attempt, skip small corrections.",
  struggling: "Learner is struggling (slow, broken sentences). For the next few turns: use simpler, shorter sentences, ask one small question at a time and give a model sentence in quotes they can copy.",
  l1_fallback: "Learner keeps switching to their own language. Give them the words they reached for in the target language, keep your turn short and ask them to say it again in the target language.",
  flowing: "Learner is speaking freely. Ask a more open, slightly harder follow-up (why, how, what if) and let them talk; correct only real mistakes.",
};

/** The hint for this turn, if any: only when the state changes or every 3rd turn it holds, so the prompt doesn't repeat it each time. */
export function nextHint(prev: { state: LearnerState; turns: number }, state: LearnerState): { hint: string; prev: { state: LearnerState; turns: number } } {
  const turns = state === prev.state ? prev.turns + 1 : 0;
  return { hint: state !== "neutral" && turns % 3 === 0 ? STATE_HINTS[state] : "", prev: { state, turns } };
}

// ---- Coaching card (SPR-27): trends over recent calls as plain sentences and one thing to try; templates, no model ----

/** What a voice session was spoken under, saved with its row (speech_sessions.conditions) so drills compare like with like. */
export type Conditions = {
  mode: "tutor" | "chat" | "rehearse" | "drill";
  drill?: "planning" | "432" | "ladder" | "structure";
  planningTimeSec: number;
  topicFamiliarity: "prepared" | "novel";
  round?: number; // 4/3/2
  rung?: number; // pressure ladder
};
/** Ordinary talk: no planning time, a topic the learner did not prepare. */
export const FREE_CONTEXT = { planningTimeSec: 0, topicFamiliarity: "novel" } as const;

export type SessionRow = { utterances: number; latency_ms: number | null; wpm: number; long_pauses: number; words: number; native_words: number;
  mode?: Conditions["mode"]; conditions?: Conditions | null; avoided?: string | null };
export type Trend = { k: "latency" | "words" | "wpm" | "pauses" | "native"; from: number; to: number };
export type Tip = "native" | "short" | "pauses" | "stretch";
export const COACH_MIN = 3;

// Per answer, `better` = which direction is progress.
const TRENDS: { k: Trend["k"]; better: 1 | -1; of: (r: SessionRow) => number | null }[] = [
  { k: "latency", better: -1, of: (r) => (r.latency_ms === null ? null : r.latency_ms / 1000) },
  { k: "words", better: 1, of: (r) => r.words / r.utterances },
  { k: "wpm", better: 1, of: (r) => r.wpm },
  { k: "pauses", better: -1, of: (r) => r.long_pauses / r.utterances },
  { k: "native", better: -1, of: (r) => (r.words ? (100 * r.native_words) / r.words : 0) }, // percent
];

/** Older half vs newer half of the calls (oldest first): up to 2 improvements of 10% or more, biggest first, and one tip
 *  from the newer half. null under COACH_MIN calls. ponytail: halves, not a regression; enough for ~10 calls. */
export function coach(rows: SessionRow[]): { trends: Trend[]; tip: Tip } | null {
  const said = rows.filter((r) => r.utterances > 0);
  if (said.length < COACH_MIN) return null;
  const half = Math.floor(said.length / 2), old = said.slice(0, half), now = said.slice(-half);
  const avg = (rs: SessionRow[], of: (r: SessionRow) => number | null) => {
    const xs = rs.flatMap((r) => { const x = of(r); return x === null ? [] : [x]; });
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const trends = TRENDS.flatMap(({ k, better, of }) => {
    const from = avg(old, of), to = avg(now, of);
    if (from === null || to === null || !from) return [];
    const gain = (better * (to - from)) / from;
    return gain >= 0.1 ? [{ k, from, to, gain }] : [];
  }).sort((a, b) => b.gain - a.gain).slice(0, 2).map(({ k, from, to }) => ({ k, from, to }));
  const n = (of: (r: SessionRow) => number | null) => avg(now, of) ?? 0;
  const tip: Tip = n(TRENDS[4].of) >= 15 ? "native" : n(TRENDS[1].of) < 5 ? "short" : n(TRENDS[3].of) >= 0.5 ? "pauses" : "stretch";
  return { trends, tip };
}
