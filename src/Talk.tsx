// Stories and roleplay chat (Faz 4). Same overlay chrome as lessons; the design only has the list screens.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { useApp } from "./store";
import { mark } from "./latency";
import { sfx, useStartLesson } from "./Lesson";
import { onTtsFallback, prewarm, resetTtsNotice, speak, speakingWith, stopSpeaking } from "./tts";
import { MicButton } from "./Mic";
import { Face, type FaceState } from "./face/Face";
import { CHARACTERS, CHAT_MAX_TURNS as CHAT_TURNS, CHAT_MIN_TURNS, FREE_GOAL, type Talk } from "./characters";
import { avoidancePass, chatTurn, debrief, learnerFacts, loadStory, rehearseTurn, rememberSession, type ChatMsg, type Story as StoryData } from "./lessons";
import { REHEARSE_LONG, type Debrief } from "./rehearsal";
import * as db from "./db";
import { recordSession, today, xpMult } from "./progress";
import { FREE_CONTEXT, summarize, type Conditions, type Utterance } from "./speech";
import { DRILL_KEEP, FOUR_THREE_TWO_MINUTES, drillConditions, drillId, drillRules, mmss, roundStat, verifyAvoidance, type RoundStat } from "./drills";
import { inField, keyAction, type KeyState } from "./keys";
import { Words } from "./Words";
import { storyId, type Cefr } from "./course";
import { SpeakButton } from "./SpeakButton";

const gap = (g: string) => ({ "--od-gap": g }) as React.CSSProperties;

export type Result = { xp: number; gems: number };

export function Shell({ label, progress, time, onClose, onRegen, body, footer }: {
  label: string; progress: number; time?: string; onClose: () => void; onRegen?: () => void; body: React.ReactNode; footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { sheet } = useApp();
  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sheet) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return (
    <div className="lesson-overlay open" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <div className="lesson-top">
        <button className="icon-btn" onClick={onClose} aria-label={t("lesson.close")}><Icon name="x" /></button>
        <div className="lesson-progress"><i style={{ width: `${progress}%` }} /></div>
        {time && <span className="muted small" style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }} role="timer">{time}</span>}
        {onRegen && <button className="icon-btn" onClick={onRegen} aria-label={t("ai.regenerate")} title={t("ai.regenerate")}><Icon name="refresh" /></button>}
      </div>
      <div className="lesson-body"><div className="lesson-inner">{body}</div></div>
      {footer && <div className="lesson-footer"><div className="foot-inner">{footer}</div></div>}
    </div>
  );
}

export function Loading({ title }: { title: string }) {
  const { t } = useTranslation();
  const { ai } = useApp();
  return (
    <div className="result-wrap" role="status">
      <div className="result-badge gen-pulse" style={{ background: "var(--blue)", boxShadow: "0 6px 0 var(--blue-dark)", color: "var(--on-accent)" }}><Icon name="spark" /></div>
      <h2 style={{ fontSize: 22, fontWeight: 900 }}>{t("ai.preparing")}</h2>
      <p className="muted small">{title} · {ai?.model}</p>
    </div>
  );
}

export function Failed({ msg, retry, quit }: { msg: string; retry: () => void; quit: () => void }) {
  const { t } = useTranslation();
  const { go } = useApp();
  return (
    <div className="result-wrap" role="alert">
      <h2 style={{ fontSize: 22, fontWeight: 900 }}>{t("ai.failed")}</h2>
      <p className="muted small" style={{ maxWidth: 480, overflowWrap: "anywhere" }}>{msg}</p>
      <div className="od-row" style={gap("10px")}>
        <button className="btn btn-primary" onClick={retry}>{t("ai.retry")}</button>
        <button className="btn btn-ghost" onClick={() => { quit(); go("settings"); }}>{t("ai.openSettings")}</button>
      </div>
    </div>
  );
}

export function Done({ title, r }: { title: string; r: Result }) {
  const { t } = useTranslation();
  return (
    <div className="result-wrap">
      <div className="result-badge" style={{ color: "var(--on-accent)" }}><Icon name="trophy" /></div>
      <h2 style={{ fontSize: 26, fontWeight: 900 }}>{title}</h2>
      <div className="result-stats">
        <span className="result-stat gold"><span className="rs-k">{t("lesson.totalXp")}</span><span className="rs-v">+{r.xp}</span></span>
        <span className="result-stat blue"><span className="rs-k">{t("lesson.gems")}</span><span className="rs-v">+{r.gems}</span></span>
      </div>
    </div>
  );
}

/** Loads the local voice while the first line is being written, so its voice is not waiting on the model too.
 *  Also the session's one notice when the chosen voice falls back to the system voice. */
export function usePrewarm(lang: string, gender?: "f" | "m") {
  const { t } = useTranslation();
  const { openSheet, closeSheet, endLesson, go } = useApp();
  useEffect(() => { prewarm(lang, gender && { gender }).catch(() => {}); }, [lang, gender]);
  useEffect(() => {
    resetTtsNotice();
    return onTtsFallback(() => openSheet(<>
      <h3>{t("voice.fellBackTitle")}</h3><p>{t("voice.fellBack")}</p>
      <button className="btn btn-primary btn-block" onClick={closeSheet}>{t("sheet.keepGoing")}</button>
      <button className="btn btn-ghost btn-block" onClick={() => { closeSheet(); endLesson(); stopSpeaking(); go("settings"); }}>{t("voice.fellBackAction")}</button>
    </>));
  }, []);
}

/** Asks before leaving a story or chat that is under way. */
export function useQuit(active: boolean) {
  const { t } = useTranslation();
  const { openSheet, closeSheet, endLesson } = useApp();
  const quit = () => { closeSheet(); endLesson(); stopSpeaking(); };
  const askQuit = () => active ? openSheet(<>
    <h3>{t("sheet.quitTitle")}</h3><p>{t("sheet.quitDesc")}</p>
    <button className="btn btn-danger btn-block" onClick={quit}>{t("sheet.quit")}</button>
    <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.keepGoing")}</button>
  </>) : quit();
  return { quit, askQuit };
}

// ---- Story: lines appear one by one, comprehension questions in between ----

export function Story({ level, unit: unitId }: { level: Cefr; unit: string }) {
  const { t } = useTranslation();
  const { course, enrollment, profile, s, setS, completeStep, sheet } = useApp();
  const unit = course?.levels[level]?.units.find((u) => u.id === unitId);
  const lang = course?.iso ?? "en";
  const [gen, setGen] = useState(0);
  const [story, setStory] = useState<StoryData | null>(null);
  const [err, setErr] = useState("");
  const [p, setP] = useState(0); // position in `seq`
  const [sel, setSel] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [shown, setShown] = useState<Set<number>>(new Set()); // lines with translation revealed
  const [result, setResult] = useState<Result | null>(null);
  const { quit, askQuit } = useQuit(!!story && !result);
  const endRef = useRef<HTMLDivElement>(null);
  usePrewarm(lang);

  useEffect(() => {
    if (!course || !enrollment || !profile || !unit || !level) return;
    let live = true;
    setStory(null); setErr(""); setP(0); setSel(null); setChecked(false); setCorrect(0);
    loadStory(enrollment.id, { course, level, native: profile.native_lang }, unit, gen > 0)
      .then((s) => live && setStory(s), (e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [gen]);

  // Lines first, each followed by the questions asked after it.
  const seq = story ? story.lines.flatMap((_, li) => [{ line: li } as { line: number; q?: number },
    ...story.questions.flatMap((q, qi) => q.after_line === li ? [{ line: li, q: qi }] : [])]) : [];
  const cur = seq[p];
  const q = cur?.q !== undefined ? story!.questions[cur.q] : null;
  const lastLine = cur?.line ?? 0;

  useEffect(() => {
    if (story && cur && cur.q === undefined) speak(story.lines[cur.line].text, lang);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [p, story]);

  const next = () => {
    if (p + 1 < seq.length) { setP(p + 1); setSel(null); setChecked(false); return; }
    const xp = (10 + correct * 10) * xpMult(s), gems = correct * 2;
    setS((s) => recordSession(s, { xp, gems, kind: "practice" }, today()));
    completeStep(storyId(level, unitId), xp);
    sfx("done");
    setResult({ xp, gems });
  };
  const check = () => { setChecked(true); sfx(sel === q!.answer ? "ok" : "bad"); if (sel === q!.answer) setCorrect((c) => c + 1); };

  // Keyboard: digits pick an answer, Enter is the footer button, Space replays the line. Esc stays in useQuit.
  const keyState: KeyState = {
    kind: q && !checked ? "choice" : "other",
    answered: false,
    options: q?.options.length ?? 0,
    listen: !!story && !result && !q,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet || inField(e.target)) return;
      const a = keyAction(e, keyState);
      if (!a) return;
      e.preventDefault();
      if (a.do === "pick") return setSel(a.index);
      if (a.do === "listen") return speak(story!.lines[lastLine].text, lang);
      if (a.do !== "primary") return;
      if (err) return setGen((g) => g + 1);
      if (!story) return;
      if (result) return quit();
      if (q && !checked) { if (sel !== null) check(); return; }
      next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const title = story?.title ?? unit?.title ?? "";
  let body: React.ReactNode, footer: React.ReactNode;
  if (err) body = <Failed msg={err} retry={() => setGen((g) => g + 1)} quit={quit} />;
  else if (!story) body = <Loading title={unit?.title ?? ""} />;
  else if (result) {
    body = <Done title={t("stories.done")} r={result} />;
    footer = <><span /><button className="btn btn-primary" onClick={quit}>{t("lesson.end")}</button></>;
  } else {
    body = <>
      <h2 className="ex-title" lang={lang}>{story.title}</h2>
      <div className="chat">
        {story.lines.slice(0, lastLine + 1).map((l, li) => (
          <SpeakButton key={li} className="bubble story-line" text={l.text} lang={lang} onClick={() => setShown((s) => new Set(s).add(li))}>
            <b className="small" style={{ color: "var(--blue)" }}>{l.speaker}</b>
            <span><Words text={l.text} lang={lang} /></span>
            {shown.has(li) && <small>{l.translation}</small>}
          </SpeakButton>
        ))}
      </div>
      {q && <div style={{ marginTop: 20 }}>
        <h3 style={{ fontWeight: 900, marginBottom: 12 }}>{q.prompt}</h3>
        <div className="opt-grid">
          {q.options.map((o, oi) => (
            <button key={oi} disabled={checked} onClick={() => setSel(oi)}
              className={`opt ${checked ? (oi === q.answer ? "correct" : oi === sel ? "wrong" : "") : oi === sel ? "sel" : ""}`}>
              <span className="opt-num">{oi + 1}</span><span lang={lang}>{o}</span>
            </button>
          ))}
        </div>
      </div>}
      <div ref={endRef} />
    </>;
    footer = q && !checked
      ? <><span className="muted small">{t("stories.tapHint")}</span><button className="btn btn-primary" disabled={sel === null} onClick={check}>{t("lesson.check")}</button></>
      : <>
        {q ? <span className={`fb ${sel === q.answer ? "good" : "bad"}`}>{t(sel === q.answer ? "lesson.correct" : "lesson.wrong")}</span> : <span className="muted small">{t("stories.tapHint")}</span>}
        <button className="btn btn-primary" onClick={next}>{t(p + 1 < seq.length ? "lesson.continue" : "lesson.finish")}</button>
      </>;
  }
  return <Shell label={title} progress={result ? 100 : seq.length ? (p / seq.length) * 100 : 0} onClose={askQuit}
    onRegen={story && !result ? () => setGen((g) => g + 1) : undefined} body={body} footer={footer} />;
}

/** After a rehearsal: where the learner got stuck, and phrases they can tap into "My words". */
function DebriefCard({ d, r, turns }: { d: Debrief; r: Result; turns: string[] }) {
  const { t } = useTranslation();
  const { course, enrollment, toast } = useApp();
  const lang = course?.iso ?? "en";
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const save = (i: number) => {
    if (!enrollment || saved.has(i)) return;
    setSaved((x) => new Set(x).add(i));
    db.addWords(enrollment.id, [[d.phrases[i].text, d.phrases[i].translation]])
      .then(() => toast(t("roleplay.phraseSaved")), (e) => { setSaved((x) => { const n = new Set(x); n.delete(i); return n; }); toast((e as Error).message); });
  };
  return (
    <div className="result-wrap">
      <h2 style={{ fontSize: 26, fontWeight: 900 }}>{t("roleplay.debriefTitle")}</h2>
      <div className="result-stats">
        <span className="result-stat gold"><span className="rs-k">{t("lesson.totalXp")}</span><span className="rs-v">+{r.xp}</span></span>
      </div>
      <div className="od-stack" style={{ ...gap("10px"), textAlign: "start", width: "100%", maxWidth: 520 }}>
        <h3 style={{ fontWeight: 900 }}>{t("roleplay.stuckTitle")}</h3>
        {d.stuck.length ? d.stuck.map((x, i) => (
          <div className="card" key={i}>
            <b className="small" style={{ color: "var(--blue)" }}>{t("roleplay.turnN", { n: x.turn + 1 })}</b>
            <p className="muted small" lang={lang}>“{turns[x.turn]}”</p>
            <p>{x.moment}</p><p className="muted small">{x.why}</p>
          </div>
        )) : <p className="muted">{t("roleplay.debriefSmooth")}</p>}
        {d.phrases.length > 0 && <>
          <h3 style={{ fontWeight: 900, marginTop: 8 }}>{t("roleplay.phrasesTitle")}</h3>
          <div className="od-row" style={{ ...gap("8px"), flexWrap: "wrap" }}>
            {d.phrases.map((p, i) => (
              <button key={i} className="word-chip" disabled={saved.has(i)} aria-pressed={saved.has(i)} onClick={() => save(i)} title={p.translation} style={{ textAlign: "start" }}>
                <Icon name={saved.has(i) ? "check" : "book"} /><span lang={lang}>{p.text}</span><span className="muted small">{p.translation}</span>
              </button>
            ))}
          </div>
        </>}
      </div>
    </div>
  );
}

// ---- Roleplay: free text chat with a character; the model corrects each message. `voice` = video-call mode: speak instead of type.
// With `talk.rehearse` the character plays someone from the learner's life instead: no corrections, no goal, the learner ends it. ----

/** 4/3/2 after round 3: the same topic told three times, side by side. "—" = not measured. */
function Rounds({ stats }: { stats: RoundStat[] }) {
  const { t } = useTranslation();
  const rows: [string, (s: NonNullable<RoundStat>) => string][] = [
    [t("practice.roundsWpm"), (s) => String(Math.round(s.wpm))],
    [t("practice.roundsPause"), (s) => `${Math.round(s.pauseRatio * 100)}%`],
    [t("practice.roundsFillers"), (s) => String(s.fillers)],
  ];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <b>{t("practice.roundsTitle")}</b>
      <table style={{ width: "100%", marginTop: 8, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        <thead><tr><th />{FOUR_THREE_TWO_MINUTES.map((min, i) => <th key={i} className="small">{t("practice.roundN", { n: i + 1, min })}</th>)}</tr></thead>
        <tbody>{rows.map(([k, f]) => (
          <tr key={k}><th className="small" style={{ textAlign: "left" }}>{k}</th>{[0, 1, 2].map((i) => <td key={i}>{stats[i] ? f(stats[i]!) : "—"}</td>)}</tr>
        ))}</tbody>
      </table>
      <p className="muted small" style={{ marginTop: 8 }}>{t("practice.roundsNote")}</p>
      {[0, 1, 2].some((i) => !stats[i]) && <p className="muted small">{t("practice.roundsUnmeasured")}</p>}
    </div>
  );
}

export function Chat({ talk }: { talk: Talk }) {
  const { who, topic, voice, rehearse, drill } = talk;
  const { t } = useTranslation();
  const { course, enrollment, profile, s, setS, gainXp, toast } = useApp();
  const ch = CHARACTERS[who];
  const name = rehearse ? rehearse.who : ch.name;
  const lang = course?.iso ?? "en";
  const [voicing, setVoicing] = useState<number | null>(null); // AI message being spoken (or its voice being made)
  const [engine, setEngine] = useState<string | null>(null); // which voice engine is speaking it, once audio starts
  const say = (text: string, i: number) => {
    setVoicing(i); setEngine(null);
    speak(text, lang, { gender: ch.gender, kokoro: ch.kokoroVoice }, () => { mark("audio"); setEngine(speakingWith()); }).finally(() => setVoicing((v) => v === i ? null : v));
  };
  usePrewarm(lang, ch.gender);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  // Loaded once per chat; a rehearsal does not use (or mark as used) the learner's facts.
  const about = useMemo(() => (profile && !rehearse ? learnerFacts(profile.id) : Promise.resolve([])), [profile?.id]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [goal, setGoal] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set()); // AI messages with translation revealed
  const [result, setResult] = useState<Result | null>(null);
  const [deb, setDeb] = useState<Debrief | null>(null);
  const [stepping, setStepping] = useState(false); // a failed debrief retries the debrief, not a turn
  const ending = useRef(false); // finish once: double click, Enter
  const req = useRef(0); // stale-response guard for async turns
  const total = drill ? drill.minutes * 60 : 0;
  const [left, setLeft] = useState(total); // drill: seconds of talk left
  const [plan, setPlan] = useState(drill?.planningSec ?? 0); // drill: planning seconds left; talk starts at 0
  const talking = !drill || plan <= 0;
  const native = voice && s.speechOn ? profile?.native_lang : undefined; // voice analysis off: nothing measured or saved
  const spoken = useRef<Utterance[]>([]);
  const heard = useRef<string[]>([]); // the learner's voice turns, for the avoidance pass
  const conditions = useRef<Conditions>(drill
    ? drillConditions(drill)
    : { ...FREE_CONTEXT, mode: rehearse ? "rehearse" : "chat" });
  /** One speech_sessions row per voice chat that measured something. */
  const saveSpeech = () => {
    if (!profile || !spoken.current.length) return;
    const x = summarize(spoken.current, 0), goal = drill?.goal;
    const avoided = goal && course && enrollment && heard.current.length
      ? avoidancePass({ course, level: enrollment.level, native: profile.native_lang }, goal, heard.current).then((r) => verifyAvoidance(goal, r), () => null)
      : Promise.resolve(null);
    void avoided.then((a) => db.saveSpeechSession(profile.id, enrollment?.id ?? null, x, conditions.current, a)).catch(() => {});
  };
  const mine = msgs.filter((m) => m.from === "me").length;
  const { quit, askQuit } = useQuit(mine > 0 && !result);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, busy]);

  const turn = async (history: ChatMsg[]) => {
    if (!course || !enrollment || !profile) return;
    const myReq = ++req.current;
    setBusy(true); setErr(""); setStepping(false);
    try {
      mark("req");
      if (rehearse) {
        const r = await rehearseTurn({ course, level: enrollment.level, native: profile.native_lang }, rehearse, history);
        if (ending.current) return; // the session ended while the reply was on its way (a drill's time ran out)
        if (req.current !== myReq) return; // a newer turn superseded this one
        mark("llm");
        setMsgs([...history, { from: "ai", text: r.reply, translation: r.translation }]);
        say(r.reply, history.length);
        return;
      }
      const r = await chatTurn({ course, level: enrollment.level, native: profile.native_lang, about: await about }, who, topic, history,
        drill ? { rules: drillRules(drill), keep: DRILL_KEEP } : {});
      if (ending.current) return;
      if (req.current !== myReq) return;
      mark("llm");
      const fixed = history.map((m, i) => i === history.length - 1 && m.from === "me" ? { ...m, correction: r.correction.trim() || undefined } : m);
      setMsgs([...fixed, { from: "ai", text: r.reply, translation: r.translation }]);
      say(r.reply, fixed.length);
      // The prompt holds the goal back too; this guards models that wrap up early anyway.
      if (r.goal_reached && history.filter((m) => m.from === "me").length >= CHAT_MIN_TURNS) setGoal(true);
    } catch (e) { if (!ending.current && req.current === myReq) { setErr((e as Error).message); setMsgs(history); } }
    finally { if (req.current === myReq) setBusy(false); }
  };
  const opened = useRef(false); // StrictMode runs effects twice; open the scene once
  useEffect(() => { if (talking && !opened.current) { opened.current = true; turn([]); } }, [talking]);
  // Drill clocks: planning counts down first, then the talk time; the talk ends itself at 0.
  // The talk clock waits for the first reply and stops while an error is on screen.
  const paused = talking && (!!err || !msgs.length);
  const start = useStartLesson();
  const [stat, setStat] = useState<RoundStat>(null); // 4/3/2: this round's numbers, set by finish()
  const r432 = drill?.kind === "432" ? drill : null;
  useEffect(() => {
    if (!drill || result || paused) return;
    const id = setInterval(() => (plan > 0 ? setPlan((p) => p - 1) : setLeft((l) => Math.max(0, l - 1))), 1000);
    return () => clearInterval(id);
  }, [!!drill, !!result, plan > 0, paused]);
  useEffect(() => { if (drill && talking && left === 0 && !result) finish(); }, [left]);

  const send = (said?: string) => {
    const v = (said ?? text).trim();
    if (!v || busy || ending.current) return;
    setText("");
    turn([...msgs, { from: "me", text: v }]);
  };
  const remember = () => {
    // ponytail: only free-topic chats and rehearsals, never drills; in a scene the learner plays a role, so "I'm a doctor" is not about them
    if (profile && !drill && (rehearse || topic.goal.startsWith(FREE_GOAL))) void rememberSession(profile.id, profile.native_lang, "chat", name, msgs.map((m) => ({ from: m.from === "me" ? "me" : "other", text: m.text })))
      .then((n) => { if (n) toast(t("memory.saved", { count: n })); });
  };
  const turns = msgs.filter((m) => m.from === "me").map((m) => m.text);
  /** Rehearsal end: one debrief call; XP only once it succeeded, so a retry cannot pay twice. */
  const stepOut = async () => {
    if (ending.current || !rehearse || !course || !enrollment || !profile) return;
    ending.current = true;
    setBusy(true); setErr(""); setStepping(true);
    try {
      const d = await debrief({ course, level: enrollment.level, native: profile.native_lang }, rehearse, turns);
      const xp = (mine * 5 + 10) * xpMult(s);
      setS((s) => recordSession(s, { xp, gems: 0, kind: "practice" }, today()));
      gainXp(xp);
      sfx("done");
      setDeb(d);
      setResult({ xp, gems: 0 });
      remember();
      saveSpeech();
    } catch (e) { ending.current = false; setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const finish = () => {
    if (ending.current) return;
    ending.current = true;
    const clean = msgs.filter((m) => m.from === "me" && !m.correction).length;
    const xp = (mine * 5 + clean * 5 + (goal ? 20 : 0)) * xpMult(s), gems = goal ? 10 : 0;
    if (xp) { setS((s) => recordSession(s, { xp, gems, kind: "practice" }, today())); gainXp(xp); } // a drill can time out with nothing said
    if (drill) stopSpeaking();
    sfx("done");
    setResult({ xp, gems });
    remember();
    saveSpeech();
    if (r432) setStat(roundStat(spoken.current.length ? summarize(spoken.current, 0) : null));
  };
  const over = drill ? left === 0 : !rehearse && (goal || mine >= CHAT_TURNS);
  const end = rehearse ? stepOut : finish, endLabel = t(rehearse ? "roleplay.outOfRole" : "lesson.finish");

  const faceState: FaceState = busy ? "thinking" : voicing !== null ? "talking" : "idle";
  const topicLabel = drill ? `${r432 ? t("practice.roundN", { n: r432.round, min: r432.minutes }) : drill.kind === "ladder" ? t("practice.rungN", { n: drill.rung }) : t(drill.kind === "structure" ? "practice.structure" : "practice.planning")} · ${drill.topic}` : rehearse ? rehearse.about ?? "" : topic.id ? t(`roleplay.topics.${who}.${topic.id}`) : topic.goal.slice(FREE_GOAL.length);
  let body: React.ReactNode, footer: React.ReactNode;
  if (result) {
    body = deb ? <DebriefCard d={deb} r={result} turns={turns} /> : <>
      <Done title={t(drill && left === 0 ? "practice.timeUp" : goal ? "roleplay.goalDone" : "roleplay.done")} r={result} />
      {r432?.round === 3 && <Rounds stats={[...(r432.prev ?? []), stat]} />}
    </>;
    const round = r432?.round ?? 3;
    footer = round < 3
      ? <><button className="btn btn-ghost" onClick={quit}>{t("lesson.end")}</button>
        <button className="btn btn-primary" onClick={() => { stopSpeaking(); start(drillId(who, { ...r432!, round: round + 1, minutes: FOUR_THREE_TWO_MINUTES[round], prev: [...(r432!.prev ?? []), stat] })); }}>{t("practice.nextRound")}</button></>
      : <><span /><button className="btn btn-primary" onClick={quit}>{t("lesson.end")}</button></>;
  } else if (!talking) {
    body = (
      <div className="result-wrap">
        <span className="muted">{t("practice.planningTitle")}</span>
        <h2 style={{ fontSize: 24, fontWeight: 900 }}>{drill!.topic}</h2>
        <span role="timer" style={{ fontSize: 56, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{mmss(plan)}</span>
      </div>
    );
    footer = <><span /><button className="btn btn-primary" onClick={() => setPlan(0)}>{t("practice.startSpeaking")}</button></>;
  } else {
    body = <>
      {voice ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 16, textAlign: "center" }}>
          <Face spec={ch.face} color={ch.color} size={220} label={name} state={faceState} scene={rehearse ? undefined : who} />
          <b>{rehearse ? t("roleplay.rehearseWith", { who: name }) : name}</b><span className="muted small">{topicLabel}</span>
        </div>
      ) : (
        <div className="od-row" style={{ ...gap("12px"), marginBottom: 16 }}>
          <Face spec={ch.face} color={ch.color} size={96} label={name} state={faceState} />
          <span className="od-field od-fill"><b>{rehearse ? t("roleplay.rehearseWith", { who: name }) : name}</b><span className="muted small">{topicLabel}</span></span>
        </div>
      )}
      {drill?.named && <p className="muted small" style={{ textAlign: "center", marginBottom: 12 }}>{t("practice.namedStructure", { structure: drill.named })}</p>}
      <div className="chat">
        {msgs.map((m, i) => m.from === "ai" ? (
          <button key={i} className="bubble" lang={lang} aria-busy={voicing === i} onClick={() => { say(m.text, i); setOpen((s) => new Set(s).add(i)); }}>
            <span>{m.text}</span>{open.has(i) && <small>{m.translation || t("practice.wordsError_translation")}</small>}
            {voicing === i && <small className="voicing gen-pulse" role="status"><Icon name="headphones" /> {engine ? t("ai.speakingWith", { engine: t(`voice.engine.${engine}`) }) : t("ai.speaking")}</small>}
          </button>
        ) : (
          <div key={i} className="bubble me" lang={lang}>
            <span>{m.text}</span>{m.correction && <small className="fix"><Icon name="spark" /> {m.correction}</small>}
          </div>
        ))}
        {busy && <div className="bubble typing" role="status" aria-label={t("ai.thinking")}>…</div>}
      </div>
      {err && <Failed msg={err} retry={stepping ? stepOut : () => turn(msgs)} quit={quit} />}
      {rehearse && mine >= REHEARSE_LONG && !busy && <p className="muted small" style={{ textAlign: "center", marginTop: 16 }}>{t("roleplay.rehearseLong")}</p>}
      {over && !busy && <p className="muted small" style={{ textAlign: "center", marginTop: 16 }}>{t(goal ? "roleplay.goalReached" : "roleplay.limit")}</p>}
      {voice && !over && <MicButton lang={lang} native={native} disabled={busy} onText={(said, m) => { if (m) spoken.current.push(m); if (said.trim()) heard.current.push(said.trim()); send(said); }} />}
      <div ref={endRef} />
    </>;
    footer = over || voice
      ? voice && !over
        ? <><span className="muted small">{t("roleplay.callHint")}</span>{mine > 0 ? <button className="btn btn-ghost" disabled={busy} onClick={end}>{endLabel}</button> : <span />}</>
        : <><span className="muted small">{t("roleplay.tapHint")}</span><button className="btn btn-primary" disabled={busy} onClick={finish}>{t("lesson.finish")}</button></>
      : <>
        <input className="input" style={{ flex: 1, fontSize: 17 }} lang={lang} value={text} autoFocus aria-label={t("roleplay.message")} placeholder={t("roleplay.placeholder")}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
        <span className="od-row" style={gap("10px")}>
          {mine > 0 && <button className="btn btn-ghost" disabled={busy} onClick={end}>{endLabel}</button>}
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => send()}>{t("roleplay.send")}</button>
        </span>
      </>;
  }
  return <Shell label={name} time={drill && talking && !result ? mmss(left) : undefined}
    progress={result ? 100 : drill ? (talking ? (left / total) * 100 : 100) : Math.min(100, (mine / (rehearse ? REHEARSE_LONG : CHAT_TURNS)) * 100)} onClose={askQuit} body={body} footer={footer} />;
}
