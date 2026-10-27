// Tutor video call: the tutor on the left, the learner's camera or profile on the right, a thin control bar below.
// Each event (speech, a typed message, silence, mic/cam toggles) gets one model reply; the rules live in src/tutor.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { useApp } from "./store";
import { biomeVars } from "./biomes";
import { mark } from "./latency";
import { sfx } from "./Lesson";
import { speak, speakingWith, stopSpeaking } from "./tts";
import { listen, sttReady, type Listener } from "./stt";
import { FREE_CONTEXT, RECENT, baselineOf, learnerState, nextHint, summarize, type LearnerState, type Utterance } from "./speech";
import { Face, type FaceState } from "./face/Face";
import { Avatar } from "./screens/Profiles";
import { CHARACTERS, type CharacterId } from "./characters";
import { judge, learnerFacts, loadPractice, rememberSession, tutorTurn } from "./lessons";
import { warmUp } from "./ai";
import { FILLER_MS, NOTES_MAX, currentUnit, filler, isNoise, mergeInput, partialSay, sentences, silenceDelay, type TutorEvent, type TutorMsg, type TutorReply } from "./tutor";
import { recordSession, today, xpMult } from "./progress";
import * as db from "./db";
import { PracticePanel } from "./PracticePanel";
import { Words } from "./Words";
import { PRACTICE_XP, answer, begin, currentItem, describePractice, expected, findTopic, needsJudge, next, openPractice, practiceTopics, type PracticeState, type Topic } from "./practice";
import { Done, Failed, Shell, useQuit, usePrewarm, type Result } from "./Talk";

const BONUS_MS = 5 * 60_000; // a call this long earns +20 XP

/** Mutable call state read by async callbacks (timers, the mic), so it lives in a ref, not in React state. */
type Call = {
  hist: TutorMsg[]; notes: string; last: TutorReply | null; queue: TutorEvent[]; fixes: string[];
  nudges: number; // silence events since the learner last said something
  fills: number; // fillers played, so each turn picks the next one
  running: boolean; over: boolean; opened: boolean; micOn: boolean; failed: TutorEvent | null;
  cut: (() => void) | null; // stops the reply being spoken, when the learner talks over it (SPR-17)
  speaking: boolean; micStarting: boolean; camStarting: boolean; // the tutor is talking; a device start is in flight
  pr: PracticeState | null; pending: TutorEvent | null; pxp: number; // practice panel state; a practice event waiting for the tutor; practice XP
  judging: boolean; // the AI is checking word tiles in another order
  speech: Utterance[]; silences: number; // speech signals and silence nudges, saved as one row at the end (SPR-25)
  mood: { state: LearnerState; turns: number }; // the learner's state at the last turn, so its hint isn't repeated every turn (SPR-26)
};

export function TutorCall({ who }: { who: CharacterId }) {
  const { t } = useTranslation();
  const { course, enrollment, profile, done, s, setS, gainXp, toast } = useApp();
  const ch = CHARACTERS[who];
  const lang = course?.iso ?? "en";
  const levelDef = course && enrollment ? course.levels[enrollment.level] : undefined;
  const unit = levelDef ? currentUnit(levelDef, done) : undefined;
  usePrewarm(lang, ch.gender);
  useEffect(warmUp, []);
  const about = useMemo(() => (profile ? learnerFacts(profile.id) : Promise.resolve([])), [profile?.id]); // loaded once per call
  const usual = useMemo(() => (profile ? db.speechBaseline(profile.id).catch(() => null) : Promise.resolve(null)), [profile?.id]);

  const c = useRef<Call>({ hist: [], notes: "", last: null, queue: [], fixes: [], nudges: 0, fills: 0, running: false, over: false, opened: false, micOn: false, failed: null, cut: null, speaking: false, micStarting: false, camStarting: false, pr: null, pending: null, pxp: 0, judging: false, speech: [], silences: 0, mood: { state: "neutral", turns: 0 } }).current;
  const mic = useRef<Listener | null>(null);
  const cam = useRef<MediaStream | null>(null);
  const ring = useRef<HTMLElement>(null);
  const silence = useRef<ReturnType<typeof setTimeout>>(undefined);
  const started = useRef(Date.now());

  const [msgs, setMsgs] = useState<TutorMsg[]>([]);
  const chat = useRef<HTMLDivElement>(null);
  const [last, setLast] = useState<TutorReply | null>(null);
  const [thinking, setThinking] = useState(false);
  const [talking, setTalking] = useState(false);
  const [engine, setEngine] = useState<string>(""); // the voice engine of the line being spoken
  const [err, setErr] = useState("");
  const [showTr, setShowTr] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micBlock, setMicBlock] = useState<string | null>(null); // i18n key: why the mic can't be used
  const [camOn, setCamOn] = useState(false);
  const [camOk, setCamOk] = useState(true);
  const [drawer, setDrawer] = useState(false); // messages popup
  const [captions, setCaptions] = useState(false); // transcript of what was said
  const [text, setText] = useState("");
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState<(Result & { fixes: string[] }) | null>(null);
  const { quit, askQuit } = useQuit(!result);
  const topics = useMemo(() => (course && enrollment ? practiceTopics(course, enrollment.level, done) : []), [course, enrollment, done]);
  const [pr, setPr] = useState<PracticeState | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [prErr, setPrErr] = useState("");
  const prTopic = useRef<Topic | null>(null); // the topic being loaded or shown
  const setPractice = (p: PracticeState | null) => { c.pr = p; setPr(p); };

  const push = (m: TutorMsg) => { c.hist = [...c.hist, m]; setMsgs(c.hist); };
  const clearSilence = () => clearTimeout(silence.current);
  const armSilence = () => {
    clearSilence();
    const sec = c.micOn && !c.over && !c.failed ? silenceDelay(c.last, c.nudges) : null;
    if (sec) silence.current = setTimeout(() => {
      c.nudges++; c.silences++;
      const stuck = !!c.pr && !!currentItem(c.pr) && !c.pr.last;
      fire(stuck ? { kind: "practice_stuck" } : { kind: "silence", seconds: sec });
    }, sec * 1000);
  };

  /** `started` gets the time the audio begins, or runs at the end if it never did. */
  const voice = async (line: string, started?: (at: number) => void) => {
    if (!line.trim() || c.over) return;
    let fired = false;
    const go = (at = performance.now()) => { if (!fired) { fired = true; setEngine(speakingWith() ?? ""); started?.(at); } };
    c.speaking = true; mic.current?.pause(s.bargeIn); setTalking(true); // the mic would hear the tutor; with barge-in it only listens harder
    try { await speak(line, lang, { gender: ch.gender, kokoro: ch.kokoroVoice }, go); } catch { /* the caption still shows it */ }
    finally {
      go();
      c.speaking = false; setTalking(false);
      // The speakers are still ringing out when playback ends: resumed at once, the mic heard the tutor's last words
      // as the learner's (a second "hello"). ponytail: fixed 400 ms, measure the output latency if a headset still echoes.
      setTimeout(() => { if (!c.speaking) mic.current?.resume(); }, 400);
    }
  };

  /** Speaks a reply's sentences as they stream in (SPR-13): the first at once, the ones that came meanwhile as one piece.
   *  The caption grows as each piece starts playing. A filler (SPR-16) plays only before the first sentence, and the reply
   *  waits for it to finish; it is not captioned and not part of the history. */
  const speaker = () => {
    const q: string[] = [];
    let busy: Promise<void> | null = null, at = -1, cut = false;
    c.cut = () => {
      cut = true; q.length = 0;
      if (at >= 0) { c.hist = c.hist.map((m, i) => (i === at ? { ...m, cut: true } : m)); setMsgs(c.hist); }
    };
    const caption = (piece: string, t: number) => {
      if (at < 0) { mark("audio", t); push({ from: "tutor", text: piece, via: "voice" }); at = c.hist.length - 1; setThinking(false); return; }
      c.hist = c.hist.map((m, i) => (i === at ? { ...m, text: `${m.text} ${piece}` } : m)); setMsgs(c.hist);
    };
    const drain = async () => {
      while (q.length && !c.over && !cut) { const piece = q.splice(0).join(" "); await voice(piece, (t) => caption(piece, t)); }
      busy = null;
    };
    return {
      add: (line: string) => { if (cut) return; q.push(line); busy ??= drain(); },
      filler: (line: string) => { if (!busy && at < 0 && !cut) busy = voice(line).then(drain); },
      end: () => busy ?? Promise.resolve(),
    };
  };

  /** One event → one reply, spoken while it streams. False when the model call failed. */
  const step = async (e: TutorEvent) => {
    if (!course || !enrollment || !profile || !unit) return false;
    if (e.kind.startsWith("practice_") && e.kind !== "practice_done" && !c.pr) return true; // the panel was closed meanwhile
    if (e.kind === "practice_read" && c.pr?.stage !== "reading") return true; // the learner moved on before the text was read
    const screen = c.pr; // what the learner was looking at when they spoke
    setThinking(true); setErr("");
    const sp = speaker();
    let n = 0; // sentences handed to the speaker
    const onText = (raw: string) => {
      if (c.over) return false;
      const p = partialSay(raw), got = sentences(p.text, p.closed);
      for (; n < got.length; n++) { if (!n) mark("say"); sp.add(got[n]); }
      if (n) clearTimeout(slow);
      return n > 0;
    };
    const waiting = e.kind === "user_said" || e.kind === "user_typed" || e.kind === "practice_answer"; // the learner expects an answer
    const slow = waiting ? setTimeout(() => sp.filler(filler(lang, c.fills++)), FILLER_MS) : undefined;
    try {
      const facts = await about;
      const said = c.speech.filter((u) => u.words > 0);
      const mood = nextHint(c.mood, learnerState(said, (await usual) ?? baselineOf(said.slice(0, -RECENT))));
      c.mood = mood.prev;
      mark("req");
      const r = await tutorTurn({ course, level: enrollment.level, native: profile.native_lang, about: facts, coach: mood.hint }, who, unit, c.hist, c.notes, e, describePractice(c.pr, topics), onText);
      mark("llm");
      if (c.over) return true;
      c.notes = r.notes.slice(0, NOTES_MAX); c.last = r; c.failed = null;
      if (r.correction.trim()) c.fixes.push(r.correction.trim());
      sentences(r.say, true).slice(n).forEach(sp.add); // the tail, or all of it if `say` came last
      setLast(r); setShowTr(false); setThinking(false);
      if (r.action === "start_practice") practiceOpen(false);
      if (r.action === "stop_practice") practiceClose();
      // `answer` only relays what the learner said; on app events the model sometimes invents a "next" and skips a step.
      // If the screen changed meanwhile (Next, a click), the answer was for the old one.
      const a = c.pr && c.pr === screen && (e.kind === "user_said" || e.kind === "user_typed") ? r.answer.trim() : "";
      const moveOn = a.toLowerCase() === "next";
      if (a && !moveOn) answerField(a);
      await sp.end();
      if (moveOn && c.pr === screen) answerField(a); // after the tutor has closed the step, not while it is still talking about it
      // The tutor has announced the reading; the app reads it aloud, then the tutor asks if it was understood.
      if (e.kind === "practice_item" && screen?.stage === "reading" && c.pr === screen && screen.set) { await voice(screen.set.reading.text); fire({ kind: "practice_read" }); }
      // The tutor has explained the answer: on to the next exercise, unless the learner already pressed Next.
      if (e.kind === "practice_answer" && c.pr === screen) advance();
      if (r.action === "end") finish();
      return true;
    } catch (x) {
      c.failed = e; setErr((x as Error).message); setThinking(false);
      return false;
    } finally {
      clearTimeout(slow); c.cut = null;
    }
  };

  /** Runs events one at a time; a waiting practice event goes first, learner input that arrived meanwhile is merged into one event. */
  const run = async (first: TutorEvent) => {
    c.running = true; clearSilence();
    let e: TutorEvent | null = first;
    while (e && !c.over && (await step(e))) { e = c.pending ?? mergeInput(c.queue.splice(0)); c.pending = null; }
    c.running = false;
    armSilence();
  };
  const fire = (e: TutorEvent) => {
    if (c.over) return;
    if (!c.running) return void run(e);
    if (e.kind === "user_said" || e.kind === "user_typed") c.queue.push(e);
    else if (e.kind.startsWith("practice_")) c.pending = e; // ponytail: only the latest practice event waits; the screen already shows the rest
    // silence and toggles while busy are dropped
  };
  const input = (kind: "user_said" | "user_typed", said: string) => {
    if (isNoise(said)) { if (!c.running) armSilence(); return; }
    c.nudges = 0;
    push({ from: "me", text: said.trim(), via: kind === "user_said" ? "voice" : "text" });
    fire({ kind, text: said.trim() });
  };
  const retry = () => { const e = c.failed; c.failed = null; setErr(""); if (e) fire(e); };

  const practiceOpen = (byButton: boolean) => {
    if (c.pr) return;
    setPrErr(""); prTopic.current = null; setPractice(openPractice());
    if (byButton) fire({ kind: "practice_opened" });
  };
  const practiceClose = () => { setPractice(null); setPrLoading(false); setPrErr(""); prTopic.current = null; };
  const chooseTopic = async (tp: Topic) => {
    if (!course || !enrollment || !profile || c.pr?.stage !== "topics" || prTopic.current) return;
    prTopic.current = tp; setPrLoading(true); setPrErr("");
    try {
      const set = await loadPractice(enrollment.id, { course, level: tp.level, native: profile.native_lang }, tp.unit);
      if (c.over || c.pr?.stage !== "topics" || prTopic.current !== tp) return;
      setPractice(begin(c.pr, set));
      fire({ kind: "practice_item" });
    } catch (x) { if (prTopic.current === tp) setPrErr((x as Error).message); }
    finally { if (prTopic.current === tp) setPrLoading(false); }
  };
  const retryTopic = () => { const tp = prTopic.current; prTopic.current = null; if (tp) void chooseTopic(tp); };
  /** A click or a spoken answer on the exercise on screen; answers that match no option are ignored. */
  const submit = async (given: string) => {
    const st = c.pr, it = st && currentItem(st);
    if (!st || !it || c.judging) return;
    let judged: boolean | undefined;
    if (it.kind === "bank" && needsJudge(it, given) && course && profile) {
      c.judging = true;
      // A failed AI call is not a wrong answer: nothing is graded, the learner just answers again.
      try { judged = (await judge({ course, level: prTopic.current?.level ?? enrollment?.level ?? "A1", native: profile.native_lang }, it.prompt, expected(it), given)).correct; }
      catch (e) { console.warn("judge", e); toast(t("lesson.checkFailed")); return; }
      finally { c.judging = false; }
      if (c.pr !== st) return; // the panel moved on meanwhile
    }
    const after = answer(st, given, judged);
    if (!after.last || after === st) return;
    setPractice(after); c.nudges = 0;
    if (after.last.correct) c.pxp += PRACTICE_XP;
    // Reading questions make no sense without their text, so only warm-up exercises go to the mistakes review.
    else if (enrollment && st.stage === "warmup") db.addMistake(enrollment.id, it).catch(() => {}); // ponytail: a lost mistake row only weakens later review
    sfx(after.last.correct ? "ok" : "bad");
    fire({ kind: "practice_answer", ...after.last });
  };
  const advance = () => {
    if (!c.pr || c.pr.stage === "topics") return; // a late reply after the panel was reopened
    c.queue.length = 0; // input queued for the old screen would be graded against the new one; it stays in the history
    const n = next(c.pr);
    if (n.stage === "done") { practiceClose(); return fire({ kind: "practice_done", score: n.score, total: n.total }); }
    setPractice(n); fire({ kind: "practice_item" });
  };
  /** The tutor's `answer` field: a topic title, "next", or the learner's spoken answer. */
  const answerField = (a: string) => {
    const st = c.pr!;
    if (st.stage === "topics") { const tp = findTopic(topics, a); if (tp) void chooseTopic(tp); }
    else if (a.toLowerCase() === "next") { if (st.stage === "reading" || st.stage === "discussion") advance(); }
    else void submit(a);
  };

  const micStart = async (announce: boolean) => {
    if (c.micStarting) return;
    c.micStarting = true;
    try {
      const m = await listen(lang, {
        utterance: (x, m) => { if (m) c.speech.push(m); input("user_said", x); },
        speech: () => {
          clearSilence(); // the learner started talking: no nudge mid-sentence
          if (c.speaking && s.bargeIn) { c.cut?.(); stopSpeaking(); } // ...over the tutor: the tutor stops (SPR-17)
        },
        level: (r) => ring.current?.style.setProperty("--level", String(Math.min(1, r * 10))),
        error: (x) => { toast(x.message); if (!c.running) armSilence(); },
      }, s.speechOn ? profile?.native_lang : undefined); // voice analysis off: nothing measured, saved or adapted to
      if (c.over) return void m.stop();
      if (c.speaking) m.pause(s.bargeIn); // turned on mid-speech: the tutor's voice would be heard
      mic.current = m; c.micOn = true; setMicOn(true);
      if (announce) fire({ kind: "mic", on: true });
      else if (!c.running) armSilence();
    } catch { setMicBlock("tutor.micDenied"); }
    finally { c.micStarting = false; }
  };
  const micStop = () => {
    c.micOn = false; setMicOn(false); clearSilence();
    ring.current?.style.setProperty("--level", "0");
    const m = mic.current; mic.current = null;
    return m?.stop();
  };
  const toggleMic = () => { if (micOn) { void micStop(); fire({ kind: "mic", on: false }); } else void micStart(true); };

  const camStop = () => { cam.current?.getTracks().forEach((x) => x.stop()); cam.current = null; setCamOn(false); };
  const toggleCam = async () => {
    if (cam.current) { camStop(); return fire({ kind: "cam", on: false }); }
    if (c.camStarting) return;
    c.camStarting = true;
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: true });
      if (c.over) return void st.getTracks().forEach((x) => x.stop());
      cam.current = st; setCamOn(true); fire({ kind: "cam", on: true });
    }
    catch { setCamOk(false); }
    finally { c.camStarting = false; }
  };

  const finish = () => {
    if (c.over) return;
    c.over = true; void micStop(); camStop(); stopSpeaking();
    const mine = c.hist.filter((m) => m.from === "me").length;
    const clean = Math.max(0, mine - c.fixes.length);
    const xp = (mine * 5 + clean * 5 + c.pxp + (Date.now() - started.current >= BONUS_MS ? 20 : 0)) * xpMult(s);
    if (xp) { setS((s) => recordSession(s, { xp, gems: 0, kind: "practice" }, today())); gainXp(xp); }
    sfx("done");
    setResult({ xp, gems: 0, fixes: [...c.fixes] });
    if (profile && c.speech.length) void db.saveSpeechSession(profile.id, enrollment?.id ?? null, summarize(c.speech, c.silences), { ...FREE_CONTEXT, mode: "tutor", topicFamiliarity: "prepared" }).catch(() => {});
    if (profile) void rememberSession(profile.id, profile.native_lang, "tutor", ch.name, c.hist.map((m) => ({ from: m.from === "me" ? "me" : "other", text: m.text })))
      .then((n) => { if (n) toast(t("memory.saved", { count: n })); });
  };
  const end = () => (c.hist.some((m) => m.from === "me") || c.pxp ? finish() : quit());

  useEffect(() => {
    c.over = false; // StrictMode mounts twice: the first cleanup must not end the call
    if (!c.opened) {
      c.opened = true;
      sttReady().then((ok) => {
        if (ok && s.speakOn) return micStart(false);
        setMicBlock(ok ? "stt.off" : "stt.unavailable");
      });
      fire({ kind: "start" });
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(tick); c.over = true; clearSilence(); void mic.current?.stop(); mic.current = null; camStop(); stopSpeaking(); };
  }, []);
  // New messages, or the list just opened: show the newest at the bottom.
  useEffect(() => { chat.current?.scrollTo(0, chat.current.scrollHeight); }, [msgs, drawer]);

  const faceState: FaceState = thinking ? "thinking" : talking ? "talking" : "idle";
  const micLabel = t(micOn ? "tutor.micOff" : "tutor.micOn"), camLabel = t(camOn ? "tutor.camOff" : "tutor.camOn");
  const spoken = msgs.filter((m) => m.via === "voice"), typed = msgs.filter((m) => m.via === "text"); // ponytail: the tutor only speaks for now; a "message" action would add tutor lines to `typed`
  // Captions show only each side's latest line, on its own card: the face stays visible, and a learner who missed it has to ask.
  const lastTutor = spoken.filter((m) => m.from === "tutor").pop(), lastMine = spoken.filter((m) => m.from === "me").pop();
  const send = () => { if (text.trim()) { input("user_typed", text); setText(""); } };
  const prLabel = t(pr ? "tutor.practiceClose" : "tutor.practice");
  const capLabel = t(captions ? "tutor.transcriptOff" : "tutor.transcriptOn");
  let body: React.ReactNode, footer: React.ReactNode;
  if (result) {
    body = <>
      <Done title={t("tutor.done")} r={result} />
      {result.fixes.length > 0 && <div className="call-fixes">
        <h3>{t("tutor.corrections")}</h3>
        {result.fixes.map((f, i) => <p key={i} className="call-fix small"><Icon name="spark" /> {f}</p>)}
      </div>}
    </>;
    footer = <><span /><button className="btn btn-primary" onClick={quit}>{t("lesson.end")}</button></>;
  } else {
    body = err ? <Failed msg={err} retry={retry} quit={quit} /> : (
      <div className={`call-grid${pr ? " practice-open" : ""}`} style={enrollment ? biomeVars(enrollment.level) : undefined}>
        {pr && <PracticePanel pr={pr} topics={topics} loading={prLoading} error={prErr} lang={lang}
          onTopic={(tp) => void chooseTopic(tp)} onAnswer={submit} onNext={advance} onHint={() => fire({ kind: "practice_stuck" })}
          onRetry={retryTopic} onClose={practiceClose} />}
        <section className="call-pane tutor" aria-label={ch.name}>
          <Face spec={ch.face} color={ch.color} label={ch.name} state={faceState} scene={who} />
          <b className="call-name">{ch.name}</b>
          {talking && engine && <small className="muted small" role="status">{t("ai.speakingWith", { engine: t(`voice.engine.${engine}`) })}</small>}
          {last?.correction.trim() && <p className="call-fix small"><Icon name="spark" /> {last.correction}</p>}
          {captions && lastTutor && <div className="call-transcript" lang={lang} aria-live="polite">
            <button className="call-line" onClick={() => setShowTr((v) => !v)}><Words text={lastTutor.text} lang={lang} />{showTr && last?.translation && <small>{last.translation}</small>}</button>
          </div>}
        </section>
        <section className="call-pane me" ref={ring} aria-label={profile?.name}>
          {camOn
            ? <video className="call-video" autoPlay muted playsInline ref={(el) => { if (el && el.srcObject !== cam.current) el.srcObject = cam.current; }} />
            : profile && <Avatar p={profile} size={96} />}
          {profile && <b className="call-name">{profile.name}</b>}
          {captions && lastMine && <div className="call-transcript" lang={lang}><p className="call-line">{lastMine.text}</p></div>}
        </section>
        {drawer && <section className="call-drawer" aria-label={t("tutor.message")}>
          <div className="od-row call-drawer-head">
            <h3>{t("tutor.message")}</h3>
            <button className="btn btn-ghost" onClick={() => setDrawer(false)} aria-label={t("tutor.hideMessages")} data-tip={t("tutor.hideMessages")}><Icon name="down" /></button>
          </div>
          <div className="chat" ref={chat}>
            {typed.length ? typed.map((m, i) => <div key={i} className="bubble me" lang={lang}><span>{m.text}</span></div>)
              : <p className="small muted">{t("tutor.noMessages")}</p>}
          </div>
          <form className="od-row" style={{ "--od-gap": "8px" } as React.CSSProperties} onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="input od-fill" lang={lang} value={text} autoFocus aria-label={t("roleplay.message")} placeholder={t("tutor.placeholder")}
              onChange={(e) => setText(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={!text.trim()} aria-label={t("tutor.send")} data-tip={t("tutor.send")}><Icon name="send" /></button>
          </form>
        </section>}
      </div>
    );
    footer = (
      <div className="call-bar" style={enrollment ? biomeVars(enrollment.level) : undefined}>
        <button className={`call-btn${drawer ? " on" : ""}`} onClick={() => setDrawer((d) => !d)} aria-pressed={drawer} aria-expanded={drawer} aria-label={t("tutor.message")} data-tip={t("tutor.message")}><Icon name="chat" /></button>
        <button className={`call-btn${captions ? " on" : ""}`} onClick={() => setCaptions((v) => !v)} aria-pressed={captions} aria-label={capLabel} data-tip={capLabel}><Icon name="captions" /></button>
        <button className={`call-btn${pr ? " on" : ""}`} onClick={() => (pr ? practiceClose() : practiceOpen(true))} aria-pressed={!!pr} aria-label={prLabel} data-tip={prLabel}><Icon name="book" /></button>
        <button className={`call-btn${micOn ? " on" : " off"}`} disabled={!!micBlock} onClick={toggleMic} aria-pressed={micOn} aria-label={micLabel} data-tip={micBlock ? t(micBlock) : micLabel}><Icon name="mic" /></button>
        <button className={`call-btn${camOn ? " on" : " off"}`} disabled={!camOk} onClick={toggleCam} aria-pressed={camOn} aria-label={camLabel} data-tip={camOk ? camLabel : t("tutor.camDenied")}><Icon name="video" /></button>
        <button className="call-btn end" onClick={end} aria-label={t("tutor.end")} data-tip={t("tutor.end")}><Icon name="phone" /></button>
      </div>
    );
  }
  return <Shell label={ch.name} progress={result ? 100 : Math.min(100, ((now - started.current) / BONUS_MS) * 100)} onClose={askQuit} body={body} footer={footer} />;
}
