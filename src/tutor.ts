// Tutor call brain: one event in, one structured reply out. Pure module, tested by src/tutor.test.ts;
// the model call is tutorTurn in src/lessons.ts. New capability = a new TUTOR_ACTIONS value + a handler in TutorCall.
import { z } from "zod";
import type { CourseLevel } from "./course";

export const TUTOR_ACTIONS = ["speak", "wait", "check_in", "end", "start_practice", "stop_practice"] as const;
export type TutorAction = (typeof TUTOR_ACTIONS)[number];

export type TutorEvent =
  | { kind: "start" }
  | { kind: "user_said"; text: string }
  | { kind: "user_typed"; text: string }
  | { kind: "silence"; seconds: number }
  | { kind: "mic"; on: boolean }
  | { kind: "cam"; on: boolean }
  // Practice together: what the screen shows is passed separately, see describePractice in src/practice.ts.
  | { kind: "practice_opened" }
  | { kind: "practice_item" }
  | { kind: "practice_read" }
  | { kind: "practice_answer"; correct: boolean; given: string; expected: string }
  | { kind: "practice_stuck" }
  | { kind: "practice_done"; score: number; total: number };

export type TutorMsg = { from: "tutor" | "me"; text: string; via: "voice" | "text"; cut?: boolean }; // cut: the learner spoke over it (SPR-17)

/** What the prompt needs; lessons.ts fills it from the character, the course and the current unit. */
export type TutorCtx = { name: string; persona: string; target: string; native: string; level: string; unit: string; words: string[]; grammar: string[]; about: string[] };

// `say` first: models write fields in schema order, so the first sentence streams out before the rest (SPR-13).
export const tutorSchema = z.object({ say: z.string(), action: z.enum(TUTOR_ACTIONS), translation: z.string(), correction: z.string(), notes: z.string(), answer: z.string() });
// Small models drop or misspell fields: a broken action means "keep talking", missing text means nothing to show.
export const looseTutor = z.object({
  say: z.string().catch(""), action: z.enum(TUTOR_ACTIONS).catch("speak"), translation: z.string().catch(""),
  correction: z.string().catch(""), notes: z.string().catch(""), answer: z.string().catch(""),
});
export type TutorReply = z.infer<typeof tutorSchema>;

export const HISTORY_IN_PROMPT = 12; // ponytail: older turns live only in `notes`; summarise them if long lessons lose the thread
export const NOTES_MAX = 300;
export const SILENCE_S = 20, WAIT_S = 60, MAX_NUDGES = 2;

export function tutorSystem(c: TutorCtx): string {
  return [
    `You are ${c.name}, a friendly online ${c.target} tutor giving a live one-to-one video lesson inside a language-learning app. The learner is a native ${c.native} speaker at CEFR level ${c.level}.`,
    `Your personality: ${c.persona} Keep your manner, but in this call you are the learner's tutor, not at your usual job.`,
    c.about.length ? `What you know about the learner from earlier lessons: ${c.about.join(" ")}` : "",
    `Lesson material, the learner's current unit "${c.unit}". Words: ${c.words.join(", ") || "(none)"}. Grammar: ${c.grammar.join(" | ") || "(none)"}.`,
    `Run the lesson like a real tutor: a short warm-up chat, then bring in a topic from the unit and practise its words and grammar with small questions, one step per turn. Then ask a real-life question about the topic ("Have you ever…?"); after the learner answers, ask them to ask you the same question and answer it yourself. If the learner brings up their own topic, follow it and weave the unit in where it fits.`,
    c.about.length ? "You remember this learner: in the warm-up, ask about one thing you know about them, and set the unit's examples in their world (their interests, plans, life) where it fits. Mention one thing at a time, never list what you know or say you keep notes." : "",
    "Each turn you get one event and choose one action:",
    "- speak: say the next thing in the lesson.",
    `- wait: the learner needs a moment (e.g. "my mic isn't working, one sec"); say a very short OK and wait.`,
    "- check_in: the learner has been quiet; gently ask if everything is OK, or repeat your question more simply.",
    "- end: the learner wants to stop or says goodbye; say a warm goodbye.",
    "- start_practice: the learner wants to do exercises together; the practice panel opens with a topic list. Ask which topic to practise.",
    "- stop_practice: close the practice panel (e.g. the learner opened it by mistake or wants to stop).",
    "In practice the app shows the exercises and checks the answers; you guide. Read out sentences the learner works with, never give away an answer before they try, and when they are stuck give a hint (a clue, a similar example, a word's meaning) instead of the answer. After a wrong answer say directly why it is wrong, then why the correct one is right.",
    `\`say\`: what you say aloud, ${c.target} only, suited to ${c.level}. This is a live call: keep it to 1–2 short sentences, at most 3 when explaining an exercise or telling a story; never a monologue, the learner should talk more than you. Always ${c.target}, even when the learner writes in another language. \`translation\`: \`say\` in ${c.native}.`,
    `\`correction\`: if the learner's latest message has a mistake, the corrected sentence and a very short explanation in ${c.native}; otherwise "". Ignore capitalization, punctuation and obvious speech-to-text slips.`,
    `\`notes\`: your private lesson notes for the next turn, at most ${NOTES_MAX} characters: where the lesson is and what to do next.`,
    "`answer`: only when the practice screen notes ask for it (a spoken answer, a topic title, or \"next\"); otherwise \"\".",
    "Messages marked (typed) were written in the call chat, not spoken; answer them aloud as usual.",
    "A line of yours marked (interrupted) was cut off by the learner: answer what they said; repeat only what they still need.",
    "Respond only with JSON matching the schema.",
  ].filter(Boolean).join("\n");
}

export function describeEvent(e: TutorEvent): string {
  switch (e.kind) {
    case "start": return "The call just connected. Greet the learner warmly and start the warm-up.";
    case "user_said": return `The learner said: "${e.text}"`;
    case "user_typed": return `The learner typed in the chat: "${e.text}"`;
    case "silence": return `The learner has been silent for ${e.seconds} seconds.`;
    case "mic": return e.on ? "The learner turned their microphone on." : "The learner turned their microphone off; they can still type.";
    case "cam": return e.on ? "The learner turned their camera on." : "The learner turned their camera off.";
    case "practice_opened": return "The learner opened the practice panel with its button. Check the last few messages: if neither of you mentioned practising or exercises, do not ask for a topic yet; ask whether they meant to open it, and use stop_practice if it was a mistake. Only if practising was just discussed, ask which topic to practise.";
    case "practice_item": return "A new practice step is on the screen. Introduce it briefly and read out any sentence the learner works with, without giving the answer. If the screen now shows the reading, the warm-up is over and the practice goes on: lead into the text in one short sentence (e.g. 'Great warm-up! Now let's read a short text about…'). Do not ask whether to continue, and do not read the text or ask about it: the app reads it aloud right after you.";
    case "practice_read": return "You have just read the reading text aloud. Ask if the learner understood it and is ready for the questions.";
    case "practice_answer": return e.correct
      ? `The learner answered "${e.given}" on the screen, which is correct. Say briefly why it is right.`
      : `The learner answered "${e.given}" on the screen, which is wrong; the correct answer is "${e.expected}". Say directly why it is wrong, then why the correct answer is right.`;
    case "practice_stuck": return "The learner seems stuck on the current exercise. Give a hint that helps them find it themselves: never say the answer.";
    case "practice_done": return `The practice is over: ${e.score} of ${e.total} answers correct. The panel is closed; give a short, warm evaluation and carry on with the lesson.`;
  }
}

/** `coach`: a hint from how the learner sounds (SPR-26, src/speech.ts), only on the turns it is new or due again. */
export function tutorPrompt(name: string, history: TutorMsg[], notes: string, e: TutorEvent, screen = "", coach = ""): string {
  const lines = history.slice(-HISTORY_IN_PROMPT).map((m) => `${m.from === "tutor" ? name : "Learner"}${m.via === "text" ? " (typed)" : ""}: ${m.text}${m.cut ? " (interrupted)" : ""}`);
  return [
    `Your notes: ${notes || "(none yet)"}`,
    `Conversation so far:\n${lines.join("\n") || "(nothing yet)"}`,
    screen ? `Practice screen:\n${screen}` : "",
    coach ? `Coach note (from how the learner sounds; act on it quietly, never mention it): ${coach}` : "",
    `Event: ${describeEvent(e)}`,
    `Choose your action and write ${name}'s turn.`,
  ].filter(Boolean).join("\n\n");
}

/** Seconds of learner silence before a `silence` event, or null for none. `nudges` = silence events since the learner last spoke. */
export function silenceDelay(last: TutorReply | null, nudges: number): number | null {
  if (!last || last.action === "end" || nudges >= MAX_NUDGES) return null;
  if (last.action === "wait") return WAIT_S;
  return last.say.trim().endsWith("?") ? SILENCE_S : null;
}

/** Learner input queued while the tutor was busy, as one event; null when there is none. */
export function mergeInput(queue: TutorEvent[]): TutorEvent | null {
  const said = queue.flatMap((e) => (e.kind === "user_said" || e.kind === "user_typed" ? [e] : []));
  if (!said.length) return null;
  const kind = said[said.length - 1].kind, text = said.map((e) => e.text).join(" ");
  return kind === "user_said" ? { kind, text } : { kind, text };
}

/** Speech-to-text output that is empty or only a noise tag ("[BLANK_AUDIO]", "(wind)"). One-word answers count. */
export const isNoise = (text: string) => !text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();

/** The unit the learner is on: the first one with an unfinished step, else the last. */
export const currentUnit = (level: CourseLevel, done: Set<string>) =>
  level.units.find((u) => u.steps.some((s) => !done.has(s.id))) ?? level.units[level.units.length - 1];

// ---- Fillers (SPR-16): a short sound while a slow reply is still on its way ----

export const FILLER_MS = 1500; // first sentence usually comes in 0.5–0.9 s (SPR-14); a filler before that would only delay it
const FILLERS: Record<string, string[]> = {
  en: ["Hmm…", "Let me see…", "Okay…"], tr: ["Hmm…", "Bir bakayım…", "Peki…"], de: ["Hmm…", "Mal sehen…", "Also…"],
  fr: ["Hmm…", "Voyons…", "Bon…"], es: ["Mmm…", "A ver…", "Bueno…"], it: ["Mmm…", "Vediamo…", "Allora…"], pt: ["Hmm…", "Deixa ver…", "Bem…"],
  hu: ["Hmm…", "Lássuk csak…", "Nos…"],
};
/** The n-th filler for the course language, in turn so the same one never plays twice in a row. */
export const filler = (lang: string, n: number) => { const f = FILLERS[lang.split("-")[0]] ?? ["Hmm…"]; return f[n % f.length]; };

// ---- Streaming (SPR-13): speak `say` sentence by sentence while the rest of the reply is still coming ----

const ESC: Record<string, string> = { n: " ", t: " ", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" };

/** The `say` value so far in a streamed (possibly fenced, unfinished) JSON reply; `closed` once its closing quote arrived. */
export function partialSay(raw: string): { text: string; closed: boolean } {
  const m = /"say"\s*:\s*"/.exec(raw);
  if (!m) return { text: "", closed: false };
  let out = "";
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') return { text: out, closed: true };
    if (ch !== "\\") { out += ch; continue; }
    const n = raw[i + 1];
    if (n === undefined) break; // escape cut in half: wait for the next chunk
    if (n === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue;
    }
    out += ESC[n] ?? n; i++;
  }
  return { text: out, closed: false };
}

/** Whole sentences in `text` (end mark + space); the unfinished tail counts only when `final`.
 *  ponytail: "Mr. Smith" splits in two; the pieces are still spoken back to back. */
export function sentences(text: string, final: boolean): string[] {
  const out: string[] = [];
  const re = /[.!?…]+["'”’)\]]*\s+/g;
  let start = 0;
  for (let m; (m = re.exec(text)); start = m.index + m[0].length) out.push(text.slice(start, m.index + m[0].length).trim());
  if (final && text.slice(start).trim()) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}
