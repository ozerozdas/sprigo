import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { useApp } from "./store";
import { useBuy } from "./screens/Screens";
import * as db from "./db";
import { SPEECH_PASS, hideAnswer, listenItems, madnessItems, matchesAnswer, normalize, speakItems, speechMisses, speechScore, type Item } from "./activities";
import { MicButton } from "./Mic";
import { answerLang } from "./evalRules";
import { sttReady } from "./stt";
import { dueToday } from "./srs";
import { prewarm, speak, SPEED } from "./tts";
import { Words } from "./Words";
import { SpeakButton } from "./SpeakButton";
import { LEGEND_PASS, UNIT_TEST_PASS, unitTestOf, appeal, examLevel, explain, grammarDrill, judge, legendStep, loadConjugation, loadLesson, prefetchNext, stepContext, type Base } from "./lessons";
import { recordSession, tally, today, xpMult, type Graded } from "./progress";
import { acceptAppeal } from "./appeal";
import { bankMatch, inField, keyAction, type KeyAction, type KeyState } from "./keys";

/** Opens a lesson, or the out-of-hearts sheet (design behaviour). Steps need an AI provider (DECISIONS C6). */
export function useStartLesson() {
  const { t } = useTranslation();
  const { s, ai, startLesson, openSheet, closeSheet, go } = useApp();
  const buy = useBuy();
  return (id: string) => {
    if (!ai && (!id.startsWith("practice-") || id === "practice-conjugate")) return openSheet(<>
      <h3>{t("ai.needed")}</h3><p>{t("ai.neededDesc")}</p>
      <button className="btn btn-primary btn-block" onClick={() => { closeSheet(); go("settings"); }}>{t("ai.setUp")}</button>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </>);
    if (!s.heartsOn || s.hearts > 0 || /^(story|chat|call|rehearse|drill|tutor):/.test(id) || TIME_LIMIT[id]) return startLesson(id); // stories, chats and timed games cost no hearts
    openSheet(<>
      <h3>{t("sheet.noHearts")}</h3><p>{t("sheet.noHeartsDesc")}</p>
      <Balance gems={s.gems} />
      <button className="btn btn-danger btn-block" onClick={() => buy("refill", 350)}>{t("sheet.refillFor", { count: 350 })}</button>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </>);
  };
}

/** Short synthesized cues (Web Audio, no sound files); App keeps `sfxState.on` in sync with the setting. */
export const sfxState = { on: true };
let actx: AudioContext | undefined;
export function sfx(kind: "ok" | "bad" | "done") {
  if (!sfxState.on) return;
  actx ??= new AudioContext();
  const notes = { ok: [660, 880], bad: [220, 175], done: [523, 659, 784] }[kind];
  notes.forEach((f, i) => {
    const o = actx!.createOscillator(), g = actx!.createGain(), at = actx!.currentTime + i * 0.1;
    o.type = kind === "bad" ? "triangle" : "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.12, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
    o.connect(g).connect(actx!.destination);
    o.start(at); o.stop(at + 0.2);
  });
}

/** Items of the practice modes, built from the learner's own data (Faz 3). `mistakeId` links a replayed mistake. */
type PItem = Item & { mistakeId?: number };
async function practiceItems(id: string, enrollmentId: number, prompts: { listen: string; conjugate: string }, base: Base | null): Promise<PItem[]> {
  const listenPrompt = prompts.listen;
  if (id === "practice-conjugate") return base ? loadConjugation(base, prompts.conjugate) : [];
  if (id === "practice-mistakes") return (await db.listMistakes<Item>(enrollmentId, 10)).map((m) => ({ ...m.item, mistakeId: m.id }));
  if (id === "practice-listen") return listenItems(await db.listWords(enrollmentId), listenPrompt);
  if (id === "practice-due") {
    const all = await db.listWords(enrollmentId);
    return listenItems(dueToday(all, new Date()).slice(0, 10), listenPrompt, 10, all); // listenItems only reorders these 10
  }
  if (id === "practice-speak") return speakItems(await db.listWords(enrollmentId));
  if (id === "practice-madness") return madnessItems(await db.listWords(enrollmentId));
  if (id === "practice-timed") return (await db.cachedLessonItems<Item>(enrollmentId)).sort(() => Math.random() - 0.5).slice(0, 20);
  return [];
}

/** Timed practice modes (seconds); the session ends when the clock runs out. */
export const TIME_LIMIT: Record<string, number> = { "practice-madness": 90, "practice-timed": 120 };

const questionOf = (it: Item) => it.kind === "learn" || it.kind === "speak" ? it.phrase : it.kind === "match" ? "match" : [it.prompt, "context" in it ? it.context : "", "listen" in it ? it.listen : ""].filter(Boolean).join(" — ");

// judged: the AI called it wrong (appealable, F); lost: a heart went for it; appealed: the one appeal is spent; verdict: the AI's reason for rejecting it
type Fb = { ok: boolean; correct: string; given: string; note?: string; judged?: boolean; lost?: boolean; appealed?: boolean; verdict?: string } | null;
type Load = { state: "loading" } | { state: "error"; msg: string } | { state: "ready"; items: PItem[] };
const gap = (g: string) => ({ "--od-gap": g }) as React.CSSProperties;

export function Lesson({ id }: { id: string }) {
  const { t } = useTranslation();
  const { s, setS, completeStep, gainXp, completeLevel, markLegendary, openSheet, closeSheet, endLesson, sheet, toast, course, enrollment, profile, ai, go } = useApp();
  const native = profile?.native_lang;
  // Keyed on stable values: `profile` changes on every stats update and must not restart the lesson.
  const ctx = useMemo(() => course && native && !id.startsWith("practice-") ? stepContext(course, id, native) : null, [course, native, id]);
  const lang = course?.iso ?? "en";
  const practice = id.startsWith("practice-");
  const drill = grammarDrill(id) !== undefined;
  const exam = examLevel(id);
  const legend = legendStep(id);
  const unitTest = unitTestOf(id);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [gen, setGen] = useState(0); // bump = regenerate (C3)
  const [i, setI] = useState(0);
  const [fb, setFb] = useState<Fb>(null);
  const [checking, setChecking] = useState(false);
  const [score, setScore] = useState({ correct: 0, xp: 0 });
  const [result, setResult] = useState<{ xp: number; acc: number; gems: number; passed?: boolean; required?: number } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [bankSel, setBankSel] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [typed, setTyped] = useState(""); // bank: letters typed to pick a word
  const [micPress, setMicPress] = useState(0); // speak: Space bumps this to press the mic
  const [matched, setMatched] = useState<{ done: string[]; left: string | null; wrong: string[]; misses: number }>({ done: [], left: null, wrong: [], misses: 0 });
  const [heard, setHeard] = useState<string | null>(null); // speak: last transcript ("" = nothing heard)
  const [stt, setStt] = useState(false);
  useEffect(() => { sttReady().then(setStt); }, []);
  const limit = TIME_LIMIT[id];
  const [left, setLeft] = useState(limit ?? 0);

  function reset() { setSel(null); setBankSel([]); setText(""); setTyped(""); setHeard(null); setFb(null); setMatched({ done: [], left: null, wrong: [], misses: 0 }); }

  useEffect(() => {
    if (!enrollment || (!ctx && !practice)) return;
    let live = true;
    setLoad({ state: "loading" }); setI(0); reset(); setScore({ correct: 0, xp: 0 });
    (ctx ? loadLesson(enrollment.id, ctx, gen > 0) : practiceItems(id, enrollment.id, { listen: t("practice.listenPrompt"), conjugate: t("conjugate.prompt") },
      course && native ? { course, level: enrollment.level, native } : null))
      .then((items) => live && setLoad({ state: "ready", items }))
      .catch((e) => live && setLoad({ state: "error", msg: (e as Error).message }));
    return () => { live = false; };
  }, [ctx, enrollment?.id, gen]);

  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);

  // Speaking items need the bundled model and the Settings switch; otherwise they are left out (D2).
  const speakOk = stt && s.speakOn;
  const list = useMemo(() => load.state === "ready" ? load.items.filter((x) => x.kind !== "speak" || speakOk) : [], [load, speakOk]);
  const it = list[i] as PItem | undefined;

  // Auto-play listening items once.
  useEffect(() => { prewarm(lang).catch(() => {}); }, [lang]); // the local voice loads while the lesson does
  useEffect(() => { if (it && (it.kind === "choice" || it.kind === "input") && it.listen) speak(it.listen, lang); }, [it, lang]);

  const quit = () => { closeSheet(); endLesson(); };
  const askQuit = () => {
    if (result || load.state !== "ready") return quit();
    openSheet(<>
      <h3>{t("sheet.quitTitle")}</h3><p>{t("sheet.quitDesc")}</p>
      <button className="btn btn-danger btn-block" onClick={quit}>{t("sheet.quit")}</button>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.keepGoing")}</button>
    </>);
  };

  const finish = () => {
    // learn cards are not scored; timed modes count only the questions reached before the clock ran out
    const total = (limit ? i + (fb ? 1 : 0) : list.filter((x) => x.kind !== "learn").length) || 1;
    const acc = Math.round((score.correct / total) * 100), gems = score.correct * 2, xp = score.xp * xpMult(s);
    setS((s) => {
      const n = recordSession(s, { xp, gems, kind: practice || drill ? "practice" : "lesson" }, today());
      return id === "practice-madness" ? { ...n, madnessBest: Math.max(n.madnessBest, score.correct * 5) } : n; // best = pairs matched
    });
    const required = legend ? LEGEND_PASS : unitTest ? UNIT_TEST_PASS : ctx?.levelDef.checkpoint?.required_score;
    const passed = exam || legend || unitTest ? acc >= required! : undefined;
    if (enrollment) {
      if (exam) (passed ? completeLevel(exam, xp) : gainXp(xp));
      else if (legend) { gainXp(xp); if (passed) markLegendary(legend); }
      else if (unitTest) (passed ? completeStep(ctx!.levelDef.units.find((u) => u.id === unitTest)!.steps.map((st) => st.id), xp) : gainXp(xp));
      else if (ctx && !drill) {
        completeStep(id, xp);
        prefetchNext(enrollment.id, ctx.course, ctx.level, id, ctx.native);
      } else gainXp(xp);
      // "My words": phrases taught or matched in this lesson become New FSRS cards; only recall (listen, due review) grades them.
      db.addWords(enrollment.id, list.flatMap((x): [string, string][] =>
        x.kind === "learn" ? [[x.phrase, x.translation]] : x.kind === "match" ? x.pairs : []));
    }
    sfx(passed === false ? "bad" : "done");
    setResult({ xp, acc, gems, passed, required });
  };

  // Clock for timed modes: ticks while the session runs, finishes it at 0 (ref: the interval must call the latest finish).
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const running = !!limit && load.state === "ready" && !result;
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(h);
  }, [running]);
  useEffect(() => { if (running && left <= 0) finishRef.current(); }, [running, left]);

  // Out of drops: shown on Continue, not on the wrong answer, so the feedback (and its appeal, F) stays reachable.
  const next = () => {
    if (s.heartsOn && !limit && s.hearts <= 0) return openSheet(<HeartsOut onEnd={quit} />);
    if (i + 1 >= list.length) return finish();
    setI(i + 1); reset();
  };

  const grade = (ok: boolean, correct: string, given: string, note?: string, judged = false) => {
    if (it && enrollment) {
      const { mistakeId, ...item } = it;
      if ((id === "practice-listen" || id === "practice-due") && it.kind === "choice") db.reviewWord(enrollment.id, it.listen, ok);
      else if (ok && mistakeId) db.deleteMistake(mistakeId);
      else if (!ok && !mistakeId) db.addMistake(enrollment.id, item);
    }
    let lost = false;
    // ponytail: an accepted appeal (F) doesn't fix the tally, the chart keeps the first verdict
    if (it && it.kind !== "learn" && it.kind !== "match") setS((x) => ({ ...x, accuracy: tally(x.accuracy, it.kind as Graded, ok) }));
    if (ok) setScore((sc) => ({ correct: sc.correct + 1, xp: sc.xp + 10 }));
    else if (s.heartsOn && !limit) {
      lost = true;
      setS((s) => ({ ...s, hearts: Math.max(0, s.hearts - 1) }));
    }
    sfx(ok ? "ok" : "bad");
    setFb({ ok, correct, given, note, judged: judged && !ok, lost });
  };

  // F: the learner disputes an AI verdict. Accepted = counts as correct; rejected = the AI's reason is shown. Throws on AI failure (sheet shows it, appeal stays open).
  const submitAppeal = async (reason: string) => {
    if (!it || !ctx || !fb) return;
    const r = await appeal(ctx, questionOf(it), fb.correct, fb.given, reason);
    closeSheet();
    if (!r.accepted) return setFb((f) => f && { ...f, appealed: true, verdict: r.reason });
    const { mistakeId, ...item } = it;
    if (enrollment) db.deleteMistakeByItem(enrollment.id, item);
    setScore((sc) => acceptAppeal(sc, 0, 0, false).score);
    if (fb.lost) setS((s) => ({ ...s, hearts: acceptAppeal({ correct: 0, xp: 0 }, s.hearts, s.maxHearts, true).hearts }));
    sfx("ok");
    setFb((f) => f && { ...f, ok: true, note: r.reason, judged: false, appealed: true, verdict: undefined });
  };

  const openExplain = () => { if (it && ctx && fb) openSheet(<ExplainSheet run={() => explain(ctx, questionOf(it), fb.correct, fb.given)} />); };
  const openAppeal = () => openSheet(<AppealSheet onSend={submitAppeal} />);

  const check = async () => {
    if (!it) return;
    if (it.kind === "choice") return grade(sel === it.answer, it.options[it.answer], sel === null ? "" : it.options[sel]);
    if (it.kind !== "bank" && it.kind !== "input") return;
    // Tiles too: "A nevem Anna" and "Anna a nevem" are both right, and the model gives only one order.
    const [given, expected] = it.kind === "bank" ? [bankSel.map((j) => it.bank[j]).join(" "), it.answer.join(" ")] : [text, it.answer];
    if (it.kind === "bank" ? normalize(given) === normalize(expected) : matchesAnswer(text, it)) return grade(true, expected, given);
    if (!ctx) return grade(false, expected, given);
    setChecking(true); // C4: string match failed, let the AI judge meaning
    // A failed AI call is not a wrong answer: no heart lost, the learner just checks again.
    try { const r = await judge(ctx, questionOf(it), expected, given); grade(r.correct, expected, given, r.feedback, true); }
    catch (e) { console.warn("judge", e); toast(t("lesson.checkFailed")); }
    finally { setChecking(false); }
  };

  const matchCols = useMemo(() => it?.kind === "match"
    ? { l: it.pairs.map((p) => p[0]), r: it.pairs.map((p) => p[1]).sort(() => Math.random() - 0.5) } : null, [it]);
  const pickMatch = (side: "l" | "r", v: string) => {
    if (fb || it?.kind !== "match" || matched.done.includes(v)) return;
    if (side === "l") return setMatched((m) => ({ ...m, left: v, wrong: [] }));
    if (!matched.left) return;
    const pair = it.pairs.find((p) => p[0] === matched.left)!;
    if (pair[1] !== v) return setMatched((m) => ({ ...m, left: null, wrong: [pair[0], v], misses: m.misses + 1 }));
    const done = [...matched.done, pair[0], pair[1]];
    setMatched((m) => ({ ...m, done, left: null, wrong: [] }));
    if (done.length === it.pairs.length * 2) {
      if (id === "practice-madness") { // speed game: misses only cost time, next board right away
        setScore((sc) => ({ correct: sc.correct + 1, xp: sc.xp + 10 }));
        sfx("ok");
        if (i + 1 >= list.length) return setLeft(0); // out of boards: let the clock effect finish with the updated score
        return next();
      }
      const ok = matched.misses <= 1; // ponytail: one slip allowed, no heart loss inside match
      setS((x) => ({ ...x, accuracy: tally(x.accuracy, "match", ok) }));
      if (ok) setScore((sc) => ({ correct: sc.correct + 1, xp: sc.xp + 10 }));
      sfx(ok ? "ok" : "bad");
      setFb({ ok, correct: it.pairs.map((p) => `${p[0]} = ${p[1]}`).join(", "), given: "" });
    }
  };

  const canCheck = !!it && !checking && (it.kind === "choice" ? sel !== null : it.kind === "bank" ? bankSel.length > 0 : it.kind === "input" ? text.trim().length > 0 : false);
  const progress = result ? 100 : list.length ? (i / list.length) * 100 : 0;
  const last = i + 1 >= list.length;
  const listenBtn = (txt: string) => (
    <div className="listen-row">
      <SpeakButton className="prompt-word" text={txt} lang={lang}><Icon name="headphones" /> {t("lesson.listen")}</SpeakButton>
      <SpeakButton className="prompt-word" text={txt} lang={lang} speed={SPEED.slow} aria-label={`${t("lesson.listenSlow")} ${SPEED.slow}×`} title={t("lesson.listenSlow")}>{SPEED.slow}×</SpeakButton>
    </div>
  );

  // Keyboard: one listener maps keys to the same actions as the buttons.
  const hit = it?.kind === "bank" ? bankMatch(it.bank, bankSel, typed) : -1;
  const audio = !it ? "" : it.kind === "learn" ? it.phrase : (it.kind === "choice" || it.kind === "input") ? it.listen : "";
  const keyState: KeyState = {
    kind: load.state !== "ready" || result || !it || it.kind === "learn" ? "other" : it.kind,
    answered: !!fb && !result,
    options: it?.kind === "choice" ? it.options.length : 0,
    matchL: matchCols?.l.length, matchR: matchCols?.r.length,
    typed, hit, listen: !!audio && !result,
    canExplain: !!fb && !fb.ok && !!ctx && !result,
    canAppeal: !!fb?.judged && !fb.appealed && !!ctx && !result,
  };
  const primary = () => {
    if (load.state === "error") return setGen((g) => g + 1);
    if (load.state !== "ready") return;
    if (result || !it) return quit();
    if (fb || it.kind === "learn") return next();
    if (canCheck) check();
  };
  const run = (a: KeyAction) => {
    if (!it && a.do !== "primary") return;
    switch (a.do) {
      case "primary": return primary();
      case "pick": return setSel(a.index);
      case "match": return matchCols && pickMatch(a.side, matchCols[a.side][a.index]);
      case "bankType": return setTyped(a.text);
      case "bankAdd": setBankSel([...bankSel, a.index]); return setTyped("");
      case "bankUndo": return setBankSel(bankSel.slice(0, -1));
      case "explain": return openExplain();
      case "appeal": return openAppeal();
      case "listen": return speak(audio, lang);
      case "mic": return setMicPress((n) => n + 1);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (!sheet) askQuit(); return; }
      if (sheet || inField(e.target) || checking) return;
      const a = keyAction(e, keyState);
      if (!a) return;
      e.preventDefault();
      run(a);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  let body: React.ReactNode;
  if (load.state === "loading") body = (
    <div className="result-wrap" role="status">
      <div className="result-badge gen-pulse" style={{ background: "var(--blue)", boxShadow: "0 6px 0 var(--blue-dark)", color: "var(--on-accent)" }}><Icon name="spark" /></div>
      <h2 style={{ fontSize: 22, fontWeight: 900 }}>{t("ai.preparing")}</h2>
      <p className="muted small">{ctx?.step.title} · {ai?.model}</p>
    </div>
  );
  else if (load.state === "error") body = (
    <div className="result-wrap" role="alert">
      <h2 style={{ fontSize: 22, fontWeight: 900 }}>{t("ai.failed")}</h2>
      <p className="muted small" style={{ maxWidth: 480, overflowWrap: "anywhere" }}>{load.msg}</p>
      <div className="od-row" style={gap("10px")}>
        <button className="btn btn-primary" onClick={() => setGen((g) => g + 1)}>{t("ai.retry")}</button>
        <button className="btn btn-ghost" onClick={() => { quit(); go("settings"); }}>{t("ai.openSettings")}</button>
      </div>
    </div>
  );
  else if (result) body = (
    <div className="result-wrap">
      <div className="result-badge" style={{ color: "var(--on-accent)", ...(result.passed === false && { background: "var(--red)", boxShadow: "0 6px 0 var(--red-dark)" }) }}>
        <Icon name={result.passed === false ? "refresh" : "trophy"} />
      </div>
      <h2 style={{ fontSize: 26, fontWeight: 900 }}>
        {result.passed === undefined ? t("lesson.done") : result.passed ? (legend ? t("lesson.legendPassed") : unitTest ? t("lesson.unitPassed") : t("lesson.examPassed", { level: exam })) : t("lesson.examFailed")}
      </h2>
      {result.passed === false && <p className="muted">{t("lesson.examNeed", { score: result.required })}</p>}
      <div className="result-stats">
        <span className="result-stat gold"><span className="rs-k">{t("lesson.totalXp")}</span><span className="rs-v">+{result.xp}</span></span>
        <span className="result-stat green"><span className="rs-k">{t("lesson.accuracy")}</span><span className="rs-v">{t("lesson.accuracyValue", { value: result.acc })}</span></span>
        <span className="result-stat blue"><span className="rs-k">{t("lesson.gems")}</span><span className="rs-v">+{result.gems}</span></span>
      </div>
    </div>
  );
  else if (!it) body = <div className="result-wrap"><p className="muted">{t("ai.empty")}</p></div>;
  else if (it.kind === "learn") body = (
    <>
      <h2 className="ex-title">{t("lesson.newPhrase")}</h2>
      <div className="card" style={{ textAlign: "center", padding: 28 }}>
        <p lang={lang} style={{ fontSize: 30, fontWeight: 900 }}><Words text={it.phrase} lang={lang} /></p>
        <p className="muted" style={{ fontSize: 18, fontWeight: 700, margin: "6px 0 14px" }}>{it.translation}</p>
        {listenBtn(it.phrase)}
        {it.note && <p className="small" style={{ marginTop: 14 }}>{it.note}</p>}
      </div>
    </>
  );
  else if (it.kind === "speak") body = (
    <>
      <h2 className="ex-title">{t("lesson.speakTitle")}</h2>
      <p className="ex-sub">{t("lesson.speakSub")}</p>
      <div className="card" style={{ textAlign: "center", padding: 22 }}>
        <p lang={lang} style={{ fontSize: 26, fontWeight: 900 }}><Words text={it.phrase} lang={lang} missed={heard ? speechMisses(it.phrase, heard) : undefined} /></p>
        <p className="muted" style={{ fontWeight: 700, margin: "4px 0 12px" }}>{it.translation}</p>
        {listenBtn(it.phrase)}
      </div>
      <MicButton lang={lang} disabled={!!fb} trigger={micPress} onText={(txt) => {
        setHeard(txt);
        const miss = speechMisses(it.phrase, txt);
        if (txt) grade(speechScore(it.phrase, txt) >= SPEECH_PASS, it.phrase, txt,
          [t("lesson.heard", { text: txt }), miss.length ? t("lesson.missed", { words: miss.join(", ") }) : ""].filter(Boolean).join(" · "));
      }} />
      {heard === "" && <p className="small" role="alert" style={{ textAlign: "center", color: "var(--orange)", fontWeight: 800 }}>{t("lesson.heardNothing")}</p>}
    </>
  );
  else if (it.kind === "choice") body = (
    <>
      <h2 className="ex-title">{it.prompt}</h2>
      {it.listen && listenBtn(it.listen)}
      {it.context && (it.big
        ? <div aria-hidden="true" style={{ fontSize: 72, textAlign: "center", margin: "8px 0 16px" }}>{it.context}</div>
        : <div className="card" lang={lang} style={{ whiteSpace: "pre-wrap", fontWeight: 700, fontSize: 18, marginBottom: 16 }}><Words text={it.context} lang={lang} off={!fb} /></div>)}
      <div className="opt-grid">
        {it.options.map((o, oi) => {
          const state = fb ? (oi === it.answer ? "correct" : oi === sel ? "wrong" : "") : oi === sel ? "sel" : "";
          return (
            <button className={`opt ${state}`} key={oi} disabled={!!fb} onClick={() => setSel(oi)}>
              <span className="opt-num">{oi + 1}</span><span>{o}</span>
            </button>
          );
        })}
      </div>
    </>
  );
  else if (it.kind === "bank") body = (
    <>
      <h2 className="ex-title">{hideAnswer(it.prompt, it.answer.join(" "))}</h2>
      <div className="bank-area">
        {bankSel.map((j) => <button className="tok" key={j} disabled={!!fb} onClick={() => setBankSel(bankSel.filter((x) => x !== j))}>{it.bank[j]}</button>)}
      </div>
      {typed && <p className="bank-typed" aria-live="polite">{typed}</p>}
      <div className="bank">
        {it.bank.map((w, j) => (
          <button className={`tok ${bankSel.includes(j) ? "used" : j === hit ? "sel" : ""}`} key={j} disabled={!!fb} onClick={() => setBankSel([...bankSel, j])}>{w}</button>
        ))}
      </div>
    </>
  );
  else if (it.kind === "input") body = (
    <>
      <h2 className="ex-title">{it.prompt}</h2>
      {it.listen && listenBtn(it.listen)}
      {it.cells ? <div className="card ctx-cells">{it.cells.map((c, n) => <span key={n}>{c}<small className="muted">{t(`conjugate.cells.${n}`)}</small></span>)}</div>
        : it.context && <div className="card" style={{ fontWeight: 700, fontSize: 18, marginBottom: 16 }}>{it.context}</div>}
      <textarea key={i} className="input" rows={3} value={text} disabled={!!fb || checking} autoFocus aria-label={t("lesson.yourAnswer")} placeholder={t("lesson.typeHere")}
        style={{ width: "100%", resize: "none", fontSize: 18 }}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canCheck) check(); } }} />
      {speakOk && profile && <MicButton key={`mic${i}`} lang={answerLang(it, lang, profile.native_lang)} disabled={!!fb || checking}
        onText={(said) => { if (said.trim()) setText((x) => [x.trim(), said.trim()].filter(Boolean).join(" ")); }} />}
    </>
  );
  else body = (
    <>
      <h2 className="ex-title">{t("lesson.matchPairs")}</h2>
      <div className="od-grid" style={{ "--od-cols": 2, "--od-gap": "12px" } as React.CSSProperties}>
        {(["l", "r"] as const).map((side) => (
          <div className="opt-grid" key={side} style={{ gridTemplateColumns: "1fr" }}>
            {matchCols![side].map((v, vi) => {
              const cls = matched.done.includes(v) ? "correct" : matched.wrong.includes(v) ? "wrong" : matched.left === v ? "sel" : "";
              const n = (side === "l" ? vi : matchCols!.l.length + vi) + 1;
              return <button key={v} className={`opt ${cls}`} disabled={matched.done.includes(v) || !!fb} onClick={() => pickMatch(side, v)}>
                {matchCols!.l.length + matchCols!.r.length <= 10 && <span className="opt-num">{n % 10}</span>}<span>{v}</span></button>;
            })}
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="lesson-overlay open" role="dialog" aria-modal="true" aria-label={t("lesson.dialog")} tabIndex={-1}>
      <div className="lesson-top">
        <button className="icon-btn" onClick={askQuit} aria-label={t("lesson.close")}><Icon name="x" /></button>
        <div className="lesson-progress"><i style={{ width: `${progress}%` }} /></div>
        {ctx && !result && (
          <button className="icon-btn" onClick={() => setGen((g) => g + 1)} disabled={load.state === "loading"} aria-label={t("ai.regenerate")} title={t("ai.regenerate")}><Icon name="refresh" /></button>
        )}
        {limit ? <div className={`timer-box ${left <= 10 ? "low" : ""}`} role="timer" aria-label={t("practice.timeLeft", { count: left })}><Icon name="clock" />{Math.floor(left / 60)}:{String(Math.max(left, 0) % 60).padStart(2, "0")}</div>
          : s.heartsOn && <div className="hearts-box"><Icon name="drop" />{s.hearts}</div>}
      </div>

      <div className="lesson-body"><div className="lesson-inner">{body}</div></div>

      {load.state === "ready" && (
        <div className={`lesson-footer ${fb ? (fb.ok ? "ok" : "bad") : ""}`}>
          <div className="foot-inner">
            {result || !it ? (
              <><span /><button className="btn btn-primary" onClick={quit}>{t("lesson.end")}</button></>
            ) : it.kind === "learn" ? (
              <><span /><button className="btn btn-primary" onClick={next}>{t(last ? "lesson.finish" : "lesson.continue")}</button></>
            ) : fb ? (
              <>
                {fb.ok ? (
                  <span className="fb good"><span className="fb-ico" style={{ color: "var(--green)" }}><Icon name="check" /></span>
                    <span>{t("lesson.correct")}{fb.note && <small>{fb.note}</small>}</span></span>
                ) : (
                  <span className="fb bad"><span className="fb-ico" style={{ color: "var(--red)" }}><Icon name="x" /></span>
                    <span>{t("lesson.wrong")}{fb.note && <small>{fb.note}</small>}<small>{t("lesson.answer", { answer: fb.correct })}</small>
                      {fb.verdict && <small role="status">{t("lesson.appealRejected", { reason: fb.verdict })}</small>}</span></span>
                )}
                <span className="od-row" style={gap("10px")}>
                  {!fb.ok && ctx && <button className="btn btn-ghost" aria-keyshortcuts="1" onClick={openExplain}>{t("lesson.explain")} <kbd className="kbd" aria-hidden="true">1</kbd></button>}
                  {fb.judged && !fb.appealed && ctx && <button className="btn btn-ghost" aria-keyshortcuts="2" onClick={openAppeal}>🚩 {t("lesson.appeal")} <kbd className="kbd" aria-hidden="true">2</kbd></button>}
                  <button className={`btn ${fb.ok ? "btn-primary" : "btn-danger"}`} onClick={next}>{t(last ? "lesson.finish" : "lesson.continue")}</button>
                </span>
              </>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={next}>{t(it.kind === "speak" ? "lesson.cantSpeak" : "lesson.skip")}</button>
                {it.kind !== "match" && it.kind !== "speak" && <button className="btn btn-primary" disabled={!canCheck} onClick={check}>{t(checking ? "lesson.checking" : "lesson.check")}</button>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// C5: optional AI explanation after a wrong answer.
function ExplainSheet({ run }: { run: () => Promise<string> }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  const [txt, setTxt] = useState<string | null>(null);
  useEffect(() => { run().then(setTxt, (e) => setTxt(`${t("ai.failed")}: ${(e as Error).message}`)); }, []);
  return <>
    <h3>{t("lesson.explain")}</h3>
    <p role="status" style={{ margin: "12px 0 18px", whiteSpace: "pre-wrap" }}>{txt ?? t("ai.thinking")}</p>
    <button className="btn btn-primary btn-block" autoFocus onClick={closeSheet}>{t("lesson.gotIt")}</button>
  </>;
}

// F: why the learner thinks the answer is right; an AI failure stays in the sheet so they can resend.
function AppealSheet({ onSend }: { onSend: (reason: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async () => {
    setBusy(true); setErr("");
    try { await onSend(reason.trim()); }
    catch (e) { console.warn("appeal", e); setErr(t("lesson.appealFailed")); setBusy(false); }
  };
  return <>
    <h3>{t("lesson.appealTitle")}</h3>
    <textarea className="input" rows={3} value={reason} autoFocus disabled={busy} aria-label={t("lesson.appealTitle")}
      style={{ width: "100%", resize: "none", margin: "12px 0" }} onChange={(e) => setReason(e.target.value)} />
    {err && <p className="small" role="alert" style={{ color: "var(--red)", fontWeight: 800, marginBottom: 12 }}>{err}</p>}
    <button className="btn btn-primary btn-block" disabled={busy || !reason.trim()} onClick={send}>{t(busy ? "lesson.checking" : "lesson.appealSend")}</button>
    <button className="btn btn-ghost btn-block" disabled={busy} onClick={closeSheet}>{t("sheet.cancel")}</button>
  </>;
}

function HeartsOut({ onEnd }: { onEnd: () => void }) {
  const { t } = useTranslation();
  const { s } = useApp();
  const buy = useBuy();
  return <>
    <h3>{t("sheet.heartsOut")}</h3><p>{t("sheet.heartsOutDesc")}</p>
    <Balance gems={s.gems} />
    <button className="btn btn-danger btn-block" onClick={() => buy("refill", 350)}>{t("sheet.refillFor", { count: 350 })}</button>
    <button className="btn btn-ghost btn-block" onClick={onEnd}>{t("sheet.endLesson")}</button>
  </>;
}

/** The learner's coins, shown where they can spend them. */
const Balance = ({ gems }: { gems: number }) => (
  <span className="stat-chip sheet-balance" style={{ color: "var(--gold-dark)" }}><Icon name="gem" />{gems}</span>
);
