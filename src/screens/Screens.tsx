import { tensesFor } from "../conjugation";
import { ProgressCharts } from "../ProgressCharts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../icons";
import { useApp } from "../store";
import { useStartLesson } from "../Lesson";
import { CardsSheet } from "../Flashcards";
import { WriteSheet } from "../Write";
import { useSpeakBlock } from "../Mic";
import { msLeft, rivalXp, zones, PROMOTE, DEMOTE, TIERS } from "../league";
import * as db from "../db";
import { dueToday } from "../srs";
import { parseWords, toCsv, type CsvError } from "../wordsCsv";
import { LISTEN_MIN_WORDS, MADNESS_MIN_WORDS } from "../activities";
import { DOUBLE_XP_MS, rollDay, today } from "../progress";
import { LEGEND_PRICE, unitGrammar } from "../lessons";
import { CHARACTERS, talkId, type CharacterId } from "../characters";
import { rehearseId, type Formality } from "../rehearsal";
import { currentUnit } from "../tutor";
import { DRILL_MINUTES, FOUR_THREE_TWO_MINUTES, type Drill, drillId, goalToName, ladderDrill, nextPlanningSec, planningHistory, structureDrill } from "../drills";
import { Face } from "../face/Face";
import { MemoryCard } from "./Memory";
import { CoachCard } from "./Coach";
import { achievements, nearest, roman, type Achievement } from "../achievements";
import { levelsOf, parseStoryId, parseUnitRef, storyId, type Cefr } from "../course";
import { BOOKMARKS_CHANGED, BookmarkButton } from "../BookmarkButton";
import { GuideSheet, jumpTo } from "./Learn";

const iconBox = (bg: string, fg: string, size = 48, radius: number | string = 12): React.CSSProperties => ({
  width: size, height: size, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: radius, background: bg, color: fg,
});

/** The eye-catching entry to a tutor call: top of the sidebar, and top of Learn on phones. */
export function LiveButton({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { openSheet } = useApp();
  return (
    <button className={`nav-live ${className}`} onClick={() => openSheet(<TutorSheet />)}>
      <Icon name="video" /><span>{t("nav.live")}</span><i className="live-dot" aria-hidden="true" />
    </button>
  );
}

/** Picks the tutor for a video lesson; also opened from the live lesson button. */
export function TutorSheet() {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  const start = useStartLesson();
  return (
    <div className="od-stack" style={{ "--od-gap": "10px" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{t("tutor.pick")}</h3>
      {(Object.keys(CHARACTERS) as CharacterId[]).map((k) => {
        const { name, color, face } = CHARACTERS[k];
        return (
          <button key={k} className="tutor-pick" onClick={() => { closeSheet(); start(`tutor:${k}`); }}>
            <Face spec={face} color={color} label={name} scene={k} />
            <b className="call-name">{name}</b>
          </button>
        );
      })}
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  );
}

/** This week's standings: simulated rivals + the learner (weekly XP). */
export function useLeague() {
  const { t } = useTranslation();
  const { s, profile } = useApp();
  const l = s.league, now = Date.now();
  const rows = (l?.rivals ?? []).map((r) => ({ n: r.n, c: r.c, xp: rivalXp(r, l!.week, now), me: false }))
    .concat({ n: profile?.name ?? "", c: profile?.color ?? "#f5b014", xp: s.weekXp, me: true })
    .sort((a, b) => b.xp - a.xp || +b.me - +a.me); // ties go to the learner, as in rankOf
  return { rows, name: t(`league.tier${l?.tier ?? 0}`), left: l ? Math.max(0, msLeft(l, now)) : 0, last: l?.last };
}

export function useBuy() {
  const { t } = useTranslation();
  const { s, setS, toast, closeSheet } = useApp();
  return (item: "refill" | "freeze" | "doubleXp" | "legendary", price: number) => {
    if (s.gems < price) return toast(t("shop.notEnough"));
    setS((s) => ({
      ...s, gems: s.gems - price,
      hearts: item === "refill" ? s.maxHearts : s.hearts,
      streakFreeze: item === "freeze" ? s.streakFreeze + 1 : s.streakFreeze,
      doubleXpUntil: item === "doubleXp" ? Math.max(Date.now(), s.doubleXpUntil) + DOUBLE_XP_MS : s.doubleXpUntil,
      legendTickets: item === "legendary" ? s.legendTickets + 1 : s.legendTickets,
    }));
    closeSheet();
    toast(t("shop.bought", { name: t(`shop.${item}`) }));
  };
}

export function Practice() {
  const { t } = useTranslation();
  const { toast, enrollment, lessonId, openSheet, course, go, setViewLevel } = useApp();
  const start = useStartLesson();
  const [data, setData] = useState<{ mistakes: number; words: db.Word[]; timed: number; saved: db.Bookmark[] }>({ mistakes: 0, words: [], timed: 0, saved: [] });
  const [loaded, reload] = useState(0);
  // Reloads when a practice session closes (lessonId → null) or words were imported.
  useEffect(() => {
    if (!enrollment || lessonId) return;
    Promise.all([db.listMistakes(enrollment.id), db.listWords(enrollment.id), db.cachedLessonItems(enrollment.id), db.listBookmarks(enrollment.id)])
      .then(([m, words, cached, saved]) => setData({ mistakes: m.length, words, timed: cached.length, saved }));
  }, [enrollment?.id, lessonId, loaded]);
  useEffect(() => { const r = () => reload((n) => n + 1); addEventListener(BOOKMARKS_CHANGED, r); return () => removeEventListener(BOOKMARKS_CHANGED, r); }, []);
  const { mistakes, words, timed, saved } = data;
  // Bookmarked targets are ids only; one whose unit no longer exists is not shown.
  const savedItems = saved.flatMap((b) => {
    const at = b.kind === "story" ? parseStoryId(b.ref) : parseUnitRef(b.ref);
    const unit = at && course?.levels[at.level]?.units.find((u) => u.id === at.unit);
    return at && unit ? [{ key: `${b.kind}:${b.ref}`, kind: b.kind, ref: b.ref, level: at.level, unitId: unit.id, title: unit.title }] : [];
  });
  const due = dueToday(words, new Date()).length;
  const speakBlock = useSpeakBlock();
  const conjTenses = course && enrollment ? tensesFor(course.iso, enrollment.level) : [];
  const card = (onClick: () => void, icon: IconName, bg: string, fg: string, title: string, desc: string) => (
    <button className="card row-item" onClick={onClick}>
      <span style={iconBox(bg, fg)}><Icon name={icon} /></span>
      <span className="od-field od-fill"><b>{title}</b><span className="muted small">{desc}</span></span>
      <span className="btn btn-ghost" style={{ pointerEvents: "none" }}>{t("practice.start")}</span>
    </button>
  );
  return (
    <>
      <h1 className="section-title" style={{ marginTop: 24 }}>{t("practice.title")}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>{t("practice.subtitle")}</p>
      <div className="od-grid" style={{ "--od-cols": 1, "--od-gap": "14px" } as React.CSSProperties}>
        {card(() => openSheet(<TutorSheet />), "video", "var(--green-tint)", "var(--green)", t("tutor.card"), t("tutor.cardDesc"))}
        {card(() => mistakes ? start("practice-mistakes") : toast(t("practice.noMistakes")), "refresh", "var(--red-tint)", "var(--red)", t("practice.mistakes"),
          mistakes ? t("practice.mistakesCount", { count: mistakes }) : t("practice.noMistakes"))}
        {/* Speaking: bundled Whisper (DECISIONS D2). */}
        {card(() => speakBlock ? toast(t(speakBlock)) : words.length ? start("practice-speak") : toast(t("practice.needWords", { count: 1 })),
          "mic", "var(--sky)", "var(--blue)", t("practice.speak"), speakBlock ? t(speakBlock) : words.length ? t("practice.speakDesc") : t("practice.needWords", { count: 1 }))}
        {card(() => openSheet(<WriteSheet />), "pen", "var(--purple-tint)", "var(--purple-dark)", t("write.title"), t("write.cardDesc"))}
        {conjTenses.length > 0 && card(() => start("practice-conjugate"), "dumbbell", "var(--gold-tint)", "var(--gold-dark)", t("conjugate.title"),
          t("conjugate.desc", { tenses: conjTenses.join(", ") }))}
        {card(() => speakBlock ? toast(t(speakBlock)) : openSheet(<DrillsSheet />), "clock", "var(--sky)", "var(--blue)", t("practice.drills"), speakBlock ? t(speakBlock) : t("practice.drillsDesc"))}
        {card(() => words.length < LISTEN_MIN_WORDS ? toast(t("practice.needWords", { count: LISTEN_MIN_WORDS })) : due ? start("practice-due") : toast(t("practice.noDue")),
          "refresh", "var(--green-tint)", "var(--green)", t("practice.due"),
          words.length < LISTEN_MIN_WORDS ? t("practice.needWords", { count: LISTEN_MIN_WORDS }) : due ? t("practice.dueDesc", { count: due }) : t("practice.noDue"))}
        {card(() => words.length ? openSheet(<CardsSheet onAdded={() => reload((n) => n + 1)} />) : toast(t("practice.needWords", { count: 1 })),
          "story", "var(--gold-tint)", "var(--gold-dark)", t("cards.title"), words.length ? t("cards.desc", { count: due }) : t("practice.needWords", { count: 1 }))}
        {card(() => words.length >= LISTEN_MIN_WORDS ? start("practice-listen") : toast(t("practice.needWords", { count: LISTEN_MIN_WORDS })),
          "headphones", "var(--purple-tint)", "var(--purple-dark)", t("practice.listen"), words.length >= LISTEN_MIN_WORDS ? t("practice.listenDesc", { count: Math.min(6, words.length) }) : t("practice.needWords", { count: LISTEN_MIN_WORDS }))}
        {card(() => words.length >= MADNESS_MIN_WORDS ? start("practice-madness") : toast(t("practice.needWords", { count: MADNESS_MIN_WORDS })),
          "bolt", "var(--gold-tint)", "var(--gold-dark)", t("league.matchName"), words.length >= MADNESS_MIN_WORDS ? t("practice.madnessDesc") : t("practice.needWords", { count: MADNESS_MIN_WORDS }))}
        {card(() => timed ? start("practice-timed") : toast(t("practice.needLesson")),
          "clock", "var(--red-tint)", "var(--orange)", t("practice.timed"), timed ? t("practice.timedDesc") : t("practice.needLesson"))}
      </div>
      <h2 className="section-title">{t("practice.saved")} <span className="muted small" style={{ fontWeight: 700 }}>({savedItems.length})</span></h2>
      {!savedItems.length && <p className="muted small">{t("practice.savedEmpty")}</p>}
      <div className="od-stack" style={{ "--od-gap": "10px" } as React.CSSProperties}>
        {savedItems.map((x) => (
          <div className="card row-item" key={x.key}>
            <button className="od-row od-fill" style={{ "--od-gap": "12px", textAlign: "left" } as React.CSSProperties} onClick={() => {
              if (x.kind === "story") return start(x.ref);
              if (x.kind === "guide") return openSheet(<GuideSheet unitId={x.unitId} level={x.level} />);
              Object.assign(jumpTo, { unit: x.unitId, until: Date.now() + 1000 }); setViewLevel(x.level); go("learn");
            }}>
              <span style={iconBox("var(--gold-tint)", "var(--gold-dark)", 40, 10)}><Icon name={x.kind === "story" ? "story" : x.kind === "guide" ? "book" : "star"} /></span>
              <span className="od-field od-fill"><b>{x.title}</b><span className="muted small">{x.level} · {t(`bookmark.${x.kind}`)}</span></span>
            </button>
            <BookmarkButton kind={x.kind} target={x.ref} title={x.title} />
          </div>
        ))}
      </div>
      <h2 className="section-title">{t("practice.myWords")} <span className="muted small" style={{ fontWeight: 700 }}>({words.length})</span></h2>
      {enrollment && <WordsFile enrollment={enrollment} words={words} onImported={() => reload((n) => n + 1)} />}
      {!words.length && <p className="muted small">{t("practice.noWords")}</p>}
      <div className="od-cluster" style={{ "--od-gap": "10px" } as React.CSSProperties}>
        {words.map((w) => {
          const col = w.strength >= 4 ? "var(--green)" : w.strength >= 2 ? "var(--gold)" : "var(--red)";
          return (
            <button className="word-chip" key={w.word} onClick={() => toast(`'${w.word}' = ${w.translation}`)} aria-label={t("practice.wordAria", { word: w.word, meaning: w.translation, strength: w.strength })}>
              <span>{w.word}</span>
              <span className="strength" aria-hidden="true"><i style={{ width: `${(w.strength / 5) * 100}%`, background: col }} /></span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Export and import of the word list as CSV, Anki-compatible (#24). */
function WordsFile({ enrollment, words, onImported }: { enrollment: db.Enrollment; words: db.Word[]; onImported: () => void }) {
  const { t } = useTranslation();
  const { toast, openSheet } = useApp();
  const pick = useRef<HTMLInputElement>(null);
  const exportCsv = async () => {
    const csv = toCsv(words), name = `sprigo-words-${enrollment.course_iso}-${today()}.csv`;
    if (db.isTauri) {
      const to = await (await import("@tauri-apps/plugin-dialog")).save({ defaultPath: name, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!to) return;
      await (await import("@tauri-apps/api/core")).invoke("write_text", { path: to, text: csv });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    toast(t("practice.wordsExported", { count: words.length }));
  };
  const importFile = async (file: File) => {
    const { words: found, errors } = parseWords(await file.text());
    const { added, updated } = await db.importWords(enrollment.id, found);
    onImported();
    const done = t("practice.wordsImported", { added, updated });
    if (errors.length) openSheet(<ImportErrors done={done} errors={errors} />);
    else toast(done);
  };
  return (
    <div className="od-cluster" style={{ "--od-gap": "8px", marginBottom: 12 } as React.CSSProperties}>
      <button className="btn btn-ghost" disabled={!words.length} onClick={() => exportCsv().catch((e) => { console.error("export words", e); toast(t("practice.wordsFileFailed")); })}>{t("practice.wordsExport")}</button>
      <button className="btn btn-ghost" onClick={() => pick.current?.click()}>{t("practice.wordsImport")}</button>
      <input ref={pick} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importFile(f).catch((err) => { console.error("import words", err); toast(t("practice.wordsFileFailed")); }); }} />
    </div>
  );
}

/** Rows an import skipped, with their line in the file. */
function ImportErrors({ done, errors }: { done: string; errors: CsvError[] }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  return (
    <div className="od-stack" style={{ "--od-gap": "10px" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{done}</h3>
      <p className="small">{t("practice.wordsSkipped", { count: errors.length })}</p>
      <ul className="small" style={{ maxHeight: 240, overflow: "auto", margin: 0, textAlign: "left" }}>
        {errors.map((e) => <li key={e.line}>{t("practice.wordsLine", { line: e.line })}: {t(`practice.wordsError_${e.reason}`)}</li>)}
      </ul>
      <button className="btn btn-primary btn-block" onClick={closeSheet}>{t("sheet.close")}</button>
    </div>
  );
}

/** All league tiers in a horizontal strip, current one centred: passed tiers on the left, locked ones on the right. */
function TierRail({ tier }: { tier: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { // scrollLeft instead of scrollIntoView so the page itself never jumps
    const el = ref.current, cur = el?.querySelector<HTMLElement>(".tier.current");
    if (el && cur) el.scrollLeft = cur.offsetLeft - (el.clientWidth - cur.clientWidth) / 2;
  }, [tier]);
  return (
    <div className="od-rail tier-rail" ref={ref}>
      {Array.from({ length: TIERS }, (_, i) => (
        <div key={i} className={`tier ${i < tier ? "passed" : i === tier ? "current" : "locked"}`} aria-current={i === tier ? "step" : undefined}>
          <span className="tier-badge"><Icon name={i > tier ? "lock" : "trophy"} size={i === tier ? 40 : 22} /></span>
          <span className="tier-name">{t(`league.tier${i}`)}</span>
        </div>
      ))}
    </div>
  );
}

export function League() {
  const { t } = useTranslation();
  const { toast, s, setS, enrollment } = useApp();
  const start = useStartLesson();
  const playMadness = async () => enrollment && (await db.listWords(enrollment.id)).length >= MADNESS_MIN_WORDS
    ? start("practice-madness") : toast(t("practice.needWords", { count: MADNESS_MIN_WORDS }));
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => { tick((n) => n + 1); setS((s) => (s.day === today() ? s : rollDay(s, today()))); }, 60_000); return () => clearInterval(id); }, [setS]); // rivals keep studying; a new week rolls while open
  const { rows, name, left, last } = useLeague();
  const { up, down } = zones(s.league?.tier ?? 0);
  const days = Math.floor(left / 86_400_000), hours = Math.floor((left % 86_400_000) / 3_600_000);
  return (
    <>
      {last && last !== "stay" && <div className={`guide-status ${last === "down" ? "bad" : ""}`} role="status" style={{ marginTop: 14 }}>
        <span className="guide-status-ico"><Icon name={last === "up" ? "trophy" : "x"} /></span>
        <span><b>{t(last === "up" ? "league.promoted" : "league.demoted", { name })}</b></span>
      </div>}
      <div className="card" style={{ marginTop: 14, textAlign: "center", padding: 28 }}>
        <TierRail tier={s.league?.tier ?? 0} />
        <h1 style={{ fontSize: 22, fontWeight: 900, marginTop: 8 }}>{t("league.title", { name })}</h1>
        <p className="muted small">{t(!down ? "league.rulesSeed" : !up ? "league.rulesTop" : "league.rules", { up, down })}</p>
        <p style={{ marginTop: 8, fontWeight: 800, color: "var(--orange)" }}><Icon name="clock" /> {t("league.timeLeft", { days, hours })}</p>
      </div>
      <div className="card" style={{ marginTop: 14, padding: 8 }}>
        {rows.map((p, i) => (
          <div className={`league-row ${p.me ? "me" : ""} ${up && i === up - 1 ? "cut-up" : down && i === rows.length - down - 1 ? "cut-down" : ""}`} key={p.n}>
            <span className={`league-rank ${i < 3 ? "top" : ""}`}>{i + 1}</span>
            <span className="avatar" style={{ background: p.c }} aria-hidden="true">{p.n[0]}</span>
            <span className="league-name">{p.n}</span>
            <span className="league-xp od-nowrap">{p.xp} XP</span>
          </div>
        ))}
      </div>
      <h2 className="section-title">{t("league.matchSection")}</h2>
      <div className="card od-row" style={{ "--od-gap": "14px" } as React.CSSProperties}>
        <span style={iconBox("var(--gold-tint)", "var(--gold-dark)")}><Icon name="bolt" /></span>
        <span className="od-field od-fill"><b>{t("league.matchName")}</b><span className="muted small">{t("league.matchBest", { count: s.madnessBest })}</span></span>
        <button className="btn btn-primary" onClick={playMadness}>{t("league.play")}</button>
      </div>
    </>
  );
}

export function Shop() {
  const { t } = useTranslation();
  const { s } = useApp();
  const buy = useBuy();
  const item = (id: "freeze" | "refill" | "doubleXp" | "legendary", ic: IconName, bg: string, fg: string, price: number, owned?: number) => (
    <div className="shop-item">
      <span className="s-icon" style={{ background: bg, color: fg }}><Icon name={ic} /></span>
      <span className="s-body"><h4>{t(`shop.${id}`)}</h4><p className="muted small">{t(`shop.${id}Desc`)}</p></span>
      {owned ? <span className="price-tag owned">{t("shop.owned", { count: owned })}</span> : (
        <button className="btn btn-blue" onClick={() => buy(id, price)}>
          <span style={{ width: 18, height: 18, display: "inline-flex" }}><Icon name="gem" size={18} /></span>{price}
        </button>
      )}
    </div>
  );
  const boostMin = Math.ceil((s.doubleXpUntil - Date.now()) / 60_000);
  return (
    <>
      <h1 className="section-title" style={{ marginTop: 24 }}>{t("shop.title")}</h1>
      <div className="card od-row" style={{ marginBottom: 18, "--od-gap": "10px" } as React.CSSProperties}>
        <span style={{ width: 26, height: 26, display: "inline-flex" }}><Icon name="gem" size={26} /></span>
        <b style={{ fontSize: 18 }}>{s.gems}</b><span className="muted">{t("shop.gemsHave")}</span>
        {boostMin > 0 && <span className="price-tag owned" style={{ marginLeft: "auto" }}>{t("shop.doubleXpActive", { count: boostMin })}</span>}
      </div>
      {item("freeze", "greenhouse", "var(--green-tint)", "var(--green-dark)", 200, s.streakFreeze)}
      {item("refill", "drop", "var(--sky)", "var(--blue-dark)", 350)}
      {item("doubleXp", "clock", "var(--sky)", "var(--blue-dark)", 120)}
      {item("legendary", "spark", "var(--purple-tint)", "var(--purple-dark)", LEGEND_PRICE)}
      {s.legendTickets > 0 && <p className="muted small">{t("learn.legendTicket", { count: s.legendTickets })}</p>}
    </>
  );
}

/** Earned achievements are all one gold; the tier sits on the badge's corner. */
function AchBadge({ a, size = 52 }: { a: Achievement; size?: number }) {
  const { t } = useTranslation();
  const title = `${t(`profile.ach.${a.family}.title`)} ${roman(a.tier)}`;
  return (
    <span className={`ach-badge ${a.earned ? "earned" : ""}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      <Icon name={a.icon} /><i>{roman(a.tier)}</i>
    </span>
  );
}

function AchRow({ a }: { a: Achievement }) {
  const { t } = useTranslation();
  const done = Math.min(a.cur, a.goal);
  return (
    <div className="card od-row" style={{ "--od-gap": "14px", textAlign: "left" } as React.CSSProperties}>
      <AchBadge a={a} size={44} />
      <span className="od-field od-fill"><b>{t(`profile.ach.${a.family}.title`)} {roman(a.tier)}</b><span className="muted small">{t(`profile.ach.${a.family}.desc`, { count: a.goal })}</span>
        {!a.earned && <span className="progress-track" style={{ display: "block", height: 10, marginTop: 6 }}><i className="progress-fill" style={{ display: "block", width: `${(done / a.goal) * 100}%` }} /></span>}
      </span>
      {a.earned ? <span style={{ color: "var(--gold-dark)" }} role="img" aria-label={t("profile.achDone")}><Icon name="check" /></span> : <span className="od-nowrap muted small" style={{ fontWeight: 800 }}>{done}/{a.goal}</span>}
    </div>
  );
}

function AchievementsSheet({ list }: { list: Achievement[] }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  return (
    <div className="od-stack" style={{ "--od-gap": "10px" } as React.CSSProperties}>
      <h3>{t("profile.achAllTitle")}</h3>
      <span className="muted small">{t("profile.achEarned", { count: list.filter((a) => a.earned).length, total: list.length })}</span>
      {list.map((a) => <AchRow key={a.id} a={a} />)}
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.close")}</button>
    </div>
  );
}

export function Profile() {
  const { t, i18n } = useTranslation();
  const { s, xp, profile, done, legendary, enrollment, go, openSheet } = useApp();
  const [words, setWords] = useState(0);
  const [wordDays, setWordDays] = useState<Record<string, number>>({});
  const [speech, setSpeech] = useState<Record<string, number>>({});
  useEffect(() => { db.speechWeeks(profile!.id).then(setSpeech); }, [profile!.id]);
  useEffect(() => {
    if (!enrollment) return;
    db.listWords(enrollment.id).then((w) => setWords(w.length));
    db.wordDays(enrollment.id).then(setWordDays);
  }, [enrollment?.id]);
  const league = useLeague();
  const since = new Date(profile!.created_at.replace(" ", "T") + "Z").toLocaleDateString(i18n.language, { month: "long", year: "numeric" });
  const stat = (v: React.ReactNode, k: string, c: string, onClick?: () => void) => {
    const Tag = onClick ? "button" : "div";
    return (
      <Tag className="card od-stat" onClick={onClick} title={onClick && t("garden.open")} style={{ "--od-gap": "2px", textAlign: "center", padding: 14 } as React.CSSProperties}>
        <span style={{ fontSize: 22, fontWeight: 900, color: c }} className="od-nowrap">{v}</span>
        <span className="muted small" style={{ fontWeight: 700 }}>{k}</span>
      </Tag>
    );
  };
  // Lessons are plain step ids; stories are `story:<unit>`. Course-bound counts are the current course's.
  const ach = achievements({
    bestStreak: s.bestStreak, bestDayXp: s.bestDayXp, xp, words, legendary: legendary.size,
    lessons: [...done].filter((d) => !d.includes(":")).length, stories: [...done].filter((d) => d.startsWith("story:")).length,
  });
  const earned = ach.filter((a) => a.earned);
  return (
    <>
      <div className="od-row profile-head" style={{ "--od-gap": "16px", marginTop: 24 } as React.CSSProperties}>
        <span className="avatar" style={{ width: 72, height: 72, fontSize: 28, background: profile!.color }}>{profile!.name[0]}</span>
        <span className="od-field od-fill"><b style={{ fontSize: 22 }}>{profile!.name}</b><span className="muted small">{t("profile.since", { date: since })}</span></span>
        {/* The top bar's garden button is easy to miss and isn't there on phones. */}
        <button className="btn btn-ghost od-row od-nowrap profile-garden" style={{ "--od-gap": "8px" } as React.CSSProperties} onClick={() => go("garden")}><Icon name="roots" />{t("profile.garden")}</button>
      </div>
      <div className="od-grid" style={{ "--od-cols": 2, "--od-gap": "12px", marginTop: 18 } as React.CSSProperties}>
        {stat(t("profile.streakDays", { count: s.streak }), t("profile.streak"), "var(--green)", () => go("garden"))}
        {stat(xp, t("profile.totalXp"), "var(--gold-dark)")}
        {stat(league.name, t("profile.currentLeague"), "var(--blue)")}
        {stat(t("profile.top3"), t("profile.bestLeague"), "var(--green-dark)")}
      </div>
      <h2 className="section-title">{t("progress.title")}</h2>
      {/* today from todayXp too: profiles from before #31 have no xpDays yet */}
      <ProgressCharts xpDays={{ [s.day]: s.todayXp, ...s.xpDays }} wordDays={wordDays} accuracy={s.accuracy} speech={speech} />
      <h2 className="section-title">{t("profile.forYou")}</h2>
      <div className="od-grid profile-cards" style={{ "--od-cols": 2, "--od-gap": "12px" } as React.CSSProperties}>
        <CoachCard />
        <MemoryCard />
      </div>
      <div className="od-row section-title" style={{ "--od-gap": "12px" } as React.CSSProperties}>
        <h2 className="od-fill" style={{ font: "inherit" }}>{t("profile.achievements")}</h2>
        <button className="small" style={{ fontWeight: 800, color: "var(--blue)" }} onClick={() => openSheet(<AchievementsSheet list={ach} />)}>{t("profile.achAll")}</button>
      </div>
      {earned.length > 0 && <div className="ach-badges" aria-label={t("profile.achEarned", { count: earned.length, total: ach.length })}>
        {earned.map((a) => <AchBadge key={a.id} a={a} />)}
      </div>}
      <div className="od-stack" style={{ "--od-gap": "12px" } as React.CSSProperties}>
        {nearest(ach).map((a) => <AchRow key={a.id} a={a} />)}
      </div>
    </>
  );
}

export function Stories() {
  const { t } = useTranslation();
  const { toast, course, enrollment, done } = useApp();
  const start = useStartLesson();
  // The current level and every one before it; earlier levels are open in full.
  const levels = course && enrollment ? levelsOf(course).slice(0, levelsOf(course).indexOf(enrollment.level) + 1) : [];
  const [level, setLevel] = useState(enrollment?.level);
  const lv = level && levels.includes(level) ? level : enrollment?.level;
  const units = (lv && course?.levels[lv]?.units) || [];
  return (
    <>
      <h1 className="section-title">{t("stories.title")}</h1>
      <p className="muted" style={{ marginBottom: 18 }}>{t("stories.subtitle")}</p>
      {levels.length > 1 && (
        <label className="od-field" style={{ marginBottom: 14, maxWidth: 200 }}><b>{t("learn.levels")}</b>
          <select className="select" value={lv} onChange={(e) => setLevel(e.target.value as Cefr)}>
            {levels.map((l) => <option key={l} value={l}>{l} · {course!.levels[l]!.title}</option>)}
          </select>
        </label>
      )}
      <div className="od-stack" style={{ "--od-gap": "12px" } as React.CSSProperties}>
        {units.map((u, ui) => {
          // A unit's story opens once the unit is started (the first one is always open); earlier levels are all open.
          const open = lv !== enrollment!.level || ui === 0 || u.steps.some((st) => done.has(st.id));
          const id = storyId(lv!, u.id);
          const read = done.has(id) || (lv === enrollment!.level && done.has(`story:${u.id}`)); // pre-1.9 id
          return (
            <div className="card row-item" key={u.id}>
              <button className="od-row od-fill" style={{ "--od-gap": "12px", textAlign: "left" } as React.CSSProperties} onClick={() => open ? start(id) : toast(t("stories.lockedToast", { unit: ui }))}>
                <span style={iconBox(open ? "var(--sky)" : "var(--surface)", open ? "var(--blue)" : "var(--text-faint)")}><Icon name={read ? "check" : open ? "story" : "lock"} /></span>
                <span className="od-field od-fill"><b>{u.title}</b><span className="muted small">{t("learn.kicker", { level: lv, unit: ui + 1 })}{u.description ? ` · ${u.description}` : ""}</span></span>
                {open && <span className="btn btn-ghost" style={{ pointerEvents: "none" }}>{t(read ? "stories.again" : "stories.read")}</span>}
              </button>
              {open && <BookmarkButton kind="story" target={id} title={u.title} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

function TopicSheet({ who, voice }: { who: CharacterId; voice: boolean }) {
  const { t } = useTranslation();
  const { closeSheet } = useApp();
  const start = useStartLesson();
  const [own, setOwn] = useState("");
  const go = (topic: string | { free: string }) => { closeSheet(); start(talkId(voice, who, topic)); };
  return (
    <div className="od-stack" style={{ "--od-gap": "14px", textAlign: "left" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{t("roleplay.pickTopic", { name: CHARACTERS[who].name })}</h3>
      {CHARACTERS[who].topics.map((x) => (
        <button key={x.id} className="btn btn-ghost btn-block" onClick={() => go(x.id)}>{t(`roleplay.topics.${who}.${x.id}`)}</button>
      ))}
      <label className="od-field" style={{ "--od-gap": "6px" } as React.CSSProperties}>
        <b>{t("roleplay.ownTopic")}</b>
        <input className="input" value={own} maxLength={120} placeholder={t("roleplay.ownTopicPlaceholder")}
          onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && own.trim()) go({ free: own.trim() }); }} />
      </label>
      <button className="btn btn-blue btn-block" disabled={!own.trim()} onClick={() => go({ free: own.trim() })}>{t("roleplay.start")}</button>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  );
}

/** The cast as a row of faces; one is picked. */
function CastPicker({ value, onChange }: { value: CharacterId; onChange: (c: CharacterId) => void }) {
  const { t } = useTranslation();
  return (
    <div className="od-field" style={{ "--od-gap": "6px" } as React.CSSProperties}>
      <b id="cast-pick">{t("roleplay.briefCast")}</b>
      <div className="seg" role="radiogroup" aria-labelledby="cast-pick">
        {(Object.keys(CHARACTERS) as CharacterId[]).map((k) => {
          const { name, color, face } = CHARACTERS[k];
          return (
            <button key={k} role="radio" aria-checked={value === k} aria-label={name} title={name} className={`btn ${value === k ? "btn-blue" : "btn-ghost"}`}
              style={{ padding: 4 }} onClick={() => onChange(k)}>
              <Face spec={face} color={color} size={44} label={name} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Rehearsal brief: who the character plays and what about; the cast member only lends a face and a voice. */
function RehearseSheet() {
  const { t } = useTranslation();
  const { closeSheet, toast } = useApp();
  const start = useStartLesson();
  const speakBlock = useSpeakBlock();
  const [who, setWho] = useState("");
  const [about, setAbout] = useState("");
  const [formality, setFormality] = useState<Formality>("neutral");
  const [cast, setCast] = useState<CharacterId>("tom");
  const go = (voice: boolean) => {
    if (!who.trim()) return;
    if (voice && speakBlock) return toast(t(speakBlock));
    closeSheet();
    start(rehearseId(voice, cast, { who: who.trim(), about: about.trim() || undefined, formality }));
  };
  const field = { "--od-gap": "6px" } as React.CSSProperties;
  return (
    <div className="od-stack" style={{ "--od-gap": "14px", textAlign: "left" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{t("roleplay.rehearse")}</h3>
      <label className="od-field" style={field}>
        <b>{t("roleplay.briefWho")}</b>
        <input className="input" value={who} maxLength={80} autoFocus placeholder={t("roleplay.briefWhoPlaceholder")}
          onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(false); }} />
      </label>
      <label className="od-field" style={field}>
        <b>{t("roleplay.briefAbout")}</b>
        <input className="input" value={about} maxLength={120} placeholder={t("roleplay.briefAboutPlaceholder")}
          onChange={(e) => setAbout(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(false); }} />
      </label>
      <div className="od-field" style={field}>
        <b id="rh-formality">{t("roleplay.briefFormality")}</b>
        <div className="seg" role="radiogroup" aria-labelledby="rh-formality">
          {(["casual", "neutral", "formal"] as const).map((f) => (
            <button key={f} role="radio" aria-checked={formality === f} className={`btn ${formality === f ? "btn-blue" : "btn-ghost"}`} onClick={() => setFormality(f)}>
              {t(`roleplay.formality${f[0].toUpperCase()}${f.slice(1)}`)}</button>
          ))}
        </div>
      </div>
      <CastPicker value={cast} onChange={setCast} />
      <span className="rp-actions sheet-actions">
        <button className="btn btn-ghost" disabled={!who.trim()} onClick={() => go(false)}>{t("roleplay.chat")}</button>
        <button className="btn btn-blue" disabled={!who.trim()} onClick={() => go(true)}><Icon name="video" /> {t("roleplay.call")}</button>
      </span>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  );
}

/** Fluency drills (epic #31): step 1 picks a drill, step 2 sets it up. Structure shows only when the current unit has a grammar pattern. */
function DrillsSheet() {
  const { t } = useTranslation();
  const { closeSheet, profile, course, enrollment, done, s, setS } = useApp();
  const start = useStartLesson();
  const level = course && enrollment ? course.levels[enrollment.level] : undefined;
  const [pick, setPick] = useState<Drill["kind"] | null>(null);
  const unit = level ? currentUnit(level, done) : undefined;
  const pattern = unit ? unitGrammar(unit)[0] : undefined; // ponytail: the unit's first pattern; a picker if learners want another
  const [topic, setTopic] = useState(unit?.title ?? "");
  const [cast, setCast] = useState<CharacterId>("leo");
  const [planSec, setPlanSec] = useState(60);
  const [rung, setRung] = useState(1);
  const [named, setNamed] = useState<string | null>(null);
  useEffect(() => {
    if (profile) db.listSpeechSessions(profile.id, 100).then((rows) => { setPlanSec(nextPlanningSec(planningHistory(rows))); setNamed(goalToName(rows.slice(-30))); }).catch(() => {});
  }, [profile?.id]);
  const list = [
    { id: "planning" as const, icon: "clock" as IconName, title: t("practice.planning"), desc: planSec ? t("practice.planningDesc", { sec: planSec, min: DRILL_MINUTES }) : t("practice.planningDescNone", { min: DRILL_MINUTES }) },
    { id: "432" as const, icon: "refresh" as IconName, title: t("practice.fourThreeTwo"), desc: t("practice.fourThreeTwoDesc") },
    { id: "ladder" as const, icon: "bolt" as IconName, title: t("practice.ladder"), desc: t("practice.ladderDesc") },
    ...(pattern ? [{ id: "structure" as const, icon: "book" as IconName, title: t("practice.structure"), desc: t("practice.structureDesc", { pattern }) }] : []),
  ];
  const go = (analysis = false) => {
    if ((!topic.trim() && !(pick === "ladder" && rung === 3)) || !pick) return;
    if (analysis) setS((s) => ({ ...s, speechOn: true }));
    closeSheet();
    start(drillId(cast, pick === "structure" ? structureDrill(topic.trim(), pattern!, named)
      : pick === "ladder" ? ladderDrill(rung, topic.trim())
      : pick === "432" ? { kind: "432", topic: topic.trim(), planningSec: 0, minutes: FOUR_THREE_TWO_MINUTES[0], round: 1, prev: [] }
      : { kind: "planning", topic: topic.trim(), planningSec: planSec, minutes: DRILL_MINUTES }));
  };
  if (!pick) return (
    <div className="od-stack" style={{ "--od-gap": "12px", textAlign: "left" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{t("practice.drills")}</h3>
      {list.map((d) => (
        <button key={d.id} className="card row-item" onClick={() => setPick(d.id)}>
          <span style={iconBox("var(--sky)", "var(--blue)", 40, 10)}><Icon name={d.icon} /></span>
          <span className="od-field od-fill"><b>{d.title}</b><span className="muted small">{d.desc}</span></span>
        </button>
      ))}
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  );
  return (
    <div className="od-stack" style={{ "--od-gap": "14px", textAlign: "left" } as React.CSSProperties}>
      <h3 style={{ textAlign: "center" }}>{list.find((d) => d.id === pick)!.title}</h3>
      {pick === "ladder" && <div className="od-field" style={{ "--od-gap": "6px" } as React.CSSProperties}>
        <b id="rung-pick">{t("practice.ladderRung")}</b>
        <div className="seg" role="radiogroup" aria-labelledby="rung-pick">
          {[1, 2, 3].map((r) => (
            <button key={r} role="radio" aria-checked={rung === r} className={`btn ${rung === r ? "btn-blue" : "btn-ghost"}`} onClick={() => setRung(r)}>{r}</button>
          ))}
        </div>
        <span className="muted small">{t(`practice.rung${rung}`)}</span>
      </div>}
      {!(pick === "ladder" && rung === 3) && <label className="od-field" style={{ "--od-gap": "6px" } as React.CSSProperties}>
        <b>{t("practice.drillTopic")}</b>
        <input className="input" value={topic} maxLength={120} placeholder={t("practice.drillTopicPlaceholder")}
          onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
      </label>}
      <CastPicker value={cast} onChange={setCast} />
      {pick !== "ladder" && !s.speechOn && <p className="muted small">{t(pick === "432" ? "practice.needAnalysis" : pick === "structure" ? "practice.needAnalysisStructure" : "practice.needAnalysisPlanning")}</p>}
      <span className="rp-actions sheet-actions">
        <button className="btn btn-ghost" onClick={() => setPick(null)}>{t("voice.back")}</button>
        {pick !== "ladder" && !s.speechOn
          ? <><button className="btn btn-ghost" disabled={!topic.trim()} onClick={() => go()}>{t("practice.start")}</button>
            <button className="btn btn-blue" disabled={!topic.trim()} onClick={() => go(true)}>{t("practice.enableAndStart")}</button></>
          : <button className="btn btn-blue" disabled={!topic.trim() && !(pick === "ladder" && rung === 3)} onClick={() => go()}>{t("practice.start")}</button>}
      </span>
    </div>
  );
}

export function Roleplay() {
  const { t } = useTranslation();
  const { toast, openSheet } = useApp();
  const speakBlock = useSpeakBlock();
  return (
    <>
      <h1 className="section-title">{t("roleplay.title")}</h1>
      <p className="muted" style={{ marginBottom: 18 }}>{t("roleplay.subtitle")}</p>
      <button className="card row-item" style={{ marginBottom: 18, width: "100%" }} onClick={() => openSheet(<RehearseSheet />)}>
        <span style={iconBox("var(--sky)", "var(--blue)")}><Icon name="users" /></span>
        <span className="od-field od-fill"><b>{t("roleplay.rehearse")}</b><span className="muted small">{t("roleplay.rehearseDesc")}</span></span>
        <span className="btn btn-blue" style={{ pointerEvents: "none" }}>{t("roleplay.start")}</span>
      </button>
      <div className="rp-grid">
        {(Object.keys(CHARACTERS) as CharacterId[]).map((k) => {
          const { name, color, face } = CHARACTERS[k];
          return (
            <div className="card rp-card" key={k}>
              <div className="rp-face"><Face spec={face} color={color} label={name} scene={k} /></div>
              <span className="od-field"><b>{name}</b><span className="muted">{t(`roleplay.roles.${k}`)}</span></span>
              <span className="rp-actions">
                <button className="btn btn-ghost" onClick={() => openSheet(<TopicSheet who={k} voice={false} />)}>{t("roleplay.chat")}</button>
                <button className="btn btn-blue" onClick={() => speakBlock ? toast(t(speakBlock)) : openSheet(<TopicSheet who={k} voice />)}><Icon name="video" /> {t("roleplay.call")}</button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Friends = the other profiles on this device (local-first, no accounts). */
function useOtherProfiles() {
  const { profile } = useApp();
  const [others, setOthers] = useState<db.Profile[]>([]);
  useEffect(() => { db.listProfiles().then((ps) => setOthers(ps.filter((p) => p.id !== profile?.id))); }, [profile?.id]);
  // Their stats may be from an earlier week: count weekly XP only if it is this week's league.
  return others.map((p) => ({ ...p, weekXp: p.stats.league?.week === profile?.stats.league?.week ? p.stats.weekXp : 0 }))
    .sort((a, b) => b.weekXp - a.weekXp);
}

export function Friends() {
  const { t } = useTranslation();
  const { logout } = useApp();
  const friends = useOtherProfiles();
  return (
    <>
      <h1 className="section-title" style={{ marginTop: 24 }}>{t("friends.title")}</h1>
      <p className="muted" style={{ marginBottom: 14 }}>{t("friends.subtitle")}</p>
      {!friends.length && <p className="muted small">{t("friends.empty")}</p>}
      <div className="od-stack" style={{ "--od-gap": "12px" } as React.CSSProperties}>
        {friends.map((f) => (
          <div className="card od-row" style={{ "--od-gap": "14px" } as React.CSSProperties} key={f.id}>
            <span className="avatar" style={{ background: f.color }}>{f.name[0]}</span>
            <span className="od-field od-fill"><b>{f.name}</b><span className="muted small">{t("friends.weekXp", { count: f.weekXp })}</span></span>
            <span className="od-row" style={{ "--od-gap": "4px", color: "var(--green)", fontWeight: 900 } as React.CSSProperties} aria-label={t("friends.streak", { count: f.stats.streak })}><Icon name="roots" />{f.stats.streak}</span>
          </div>
        ))}
      </div>
      <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} onClick={logout}>{t("friends.add")}</button>
    </>
  );
}

/** Built from the learner's own state; nothing is pushed from outside. */
export function Notifications() {
  const { t } = useTranslation();
  const { s } = useApp();
  const { rows, name, last } = useLeague();
  const ahead = useOtherProfiles().find((f) => f.weekXp > s.weekXp);
  const rank = rows.findIndex((r) => r.me) + 1;
  const items: { icon: IconName; title: string; desc: string }[] = [
    s.lastActive === today()
      ? { icon: "roots", title: t("notifications.streakSafe"), desc: t("notifications.streakSafeDesc", { count: s.streak }) }
      : { icon: "roots", title: t(s.streak ? "notifications.streakRisk" : "notifications.streakStart"), desc: t(s.streak ? "notifications.streakRiskDesc" : "notifications.streakStartDesc", { count: s.streak }) },
    { icon: "trophy", title: t("notifications.league", { rank, name }), desc: !zones(s.league?.tier ?? 0).up ? t("notifications.leagueTop", { count: DEMOTE }) : t(rank <= PROMOTE ? "notifications.leagueUp" : "notifications.leagueChase", { count: PROMOTE }) },
  ];
  if (last && last !== "stay") items.push({ icon: "trophy", title: t(last === "up" ? "league.promoted" : "league.demoted", { name }), desc: "" });
  if (ahead) items.push({ icon: "users", title: t("notifications.passed", { name: ahead.name }), desc: t("notifications.passedDesc", { name: ahead.name }) });
  if (s.chests) items.push({ icon: "basket", title: t("notifications.chest"), desc: t("notifications.chestDesc") });
  return (
    <>
      <h1 className="section-title" style={{ marginTop: 24 }}>{t("notifications.title")}</h1>
      <div className="od-stack" style={{ "--od-gap": "10px", marginTop: 14 } as React.CSSProperties}>
        {items.map((n) => (
          <div className="card od-row-top" style={{ "--od-gap": "12px" } as React.CSSProperties} key={n.title}>
            <span style={iconBox("var(--surface)", "inherit", 40, 10)}><Icon name={n.icon} /></span>
            <span className="od-field od-fill"><b>{n.title}</b>{n.desc && <span className="muted small">{n.desc}</span>}</span>
          </div>
        ))}
      </div>
    </>
  );
}
