import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useApp } from "./store";
import * as db from "./db";
import { lessonWord } from "./lessons";
import { tokens, type Lookup } from "./lookup";
import { normalize } from "./activities";
import { SpeakButton } from "./SpeakButton";
import { Icon } from "./icons";

/** Target-language text whose words open their meaning on tap (#28); words in the learner's list are marked (#27).
 *  `off` while the text would give away a graded answer. */
export function Words({ text, lang, off, missed }: { text: string; lang: string; off?: boolean; missed?: string[] }) {
  const { enrollment } = useApp();
  const [at, setAt] = useState<{ word: string; el: HTMLElement } | null>(null);
  const [known, setKnown] = useState<Set<string>>(new Set());
  // ponytail: single words only; a saved phrase ("buenos días") isn't marked inside a sentence
  useEffect(() => {
    if (enrollment && !off) db.knownWords(enrollment.id).then((ws) => setKnown(new Set(ws.map((w) => w.toLocaleLowerCase(lang)))));
  }, [enrollment?.id, lang, off, at]); // `at`: a word added from the card shows up once it closes
  if (off) return <>{text}</>;
  const open = (e: React.SyntheticEvent<HTMLElement>, word: string) => { e.stopPropagation(); e.preventDefault(); setAt({ word, el: e.currentTarget }); };
  const tks = tokens(text, lang), miss = [...missed ?? []], marked = tks.map(() => false);
  // speechMisses words → tokens; a token like "2.99" normalizes to several words. ponytail: repeats mark their last copies, the transcript can't say which copy was said
  for (let i = tks.length - 1; i >= 0; i--) if (tks[i].word) for (const w of normalize(tks[i].text, lang).split(" ")) {
    const k = miss.indexOf(w); if (k >= 0) { miss.splice(k, 1); marked[i] = true; }
  }
  return <>
    {tks.map((tk, i) => tk.word
      ? <span key={i} className={`tap-word${known.has(tk.text.toLocaleLowerCase(lang)) ? " known" : ""}${marked[i] ? " missed" : ""}`} role="button" tabIndex={0} onClick={(e) => open(e, tk.text)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") open(e, tk.text); }}>{tk.text}</span>
      : tk.text)}
    {at && <WordCard word={at.word} sentence={text} lang={lang} anchor={at.el} onClose={() => setAt(null)} />}
  </>;
}

function WordCard({ word, sentence, lang, anchor, onClose }: { word: string; sentence: string; lang: string; anchor: HTMLElement; onClose: () => void }) {
  const { t } = useTranslation();
  const { course, enrollment, profile, toast } = useApp();
  const [r, setR] = useState<Lookup | null>(null);
  const [err, setErr] = useState("");
  const [added, setAdded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!course || !enrollment || !profile) return;
    let live = true;
    lessonWord(enrollment.id, { course, level: enrollment.level, native: profile.native_lang }, word, sentence)
      .then(async (x) => {
        const have = (await db.listWords(enrollment.id)).some((w) => w.word === x.lemma);
        if (live) { setR(x); setAdded(have); }
      }, (e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [word]);

  // Native popover: top layer, Esc and outside clicks close it. Placed under the word, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current!, a = anchor.getBoundingClientRect();
    el.showPopover();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(a.left, innerWidth - w - 8))}px`;
    el.style.top = `${a.bottom + 8 + h > innerHeight ? Math.max(8, a.top - h - 8) : a.bottom + 8}px`;
  }, [r, err]);

  const add = () => {
    if (!enrollment || !r) return;
    setAdded(true);
    db.addWords(enrollment.id, [[r.lemma, r.translation]]).then(() => toast(t("lookup.added")), (e) => { setAdded(false); toast((e as Error).message); });
  };

  return createPortal(
    <div ref={ref} popover="auto" className="word-card" role="dialog" aria-label={word} onToggle={(e) => { if ((e as unknown as ToggleEvent).newState === "closed") onClose(); }}>
      {err ? <p className="small" role="alert">{t("lookup.failed")}</p>
        : !r ? <p className="muted small" role="status">{t("lookup.loading")}</p>
        : <>
          <div className="word-card-head">
            <b lang={lang}>{r.lemma}</b>{r.pos && <span className="muted small">{r.pos}</span>}
            <SpeakButton className="icon-btn" text={r.lemma} lang={lang} aria-label={t("lesson.listen")}><Icon name="headphones" /></SpeakButton>
          </div>
          <p style={{ fontWeight: 800 }}>{r.translation}</p>
          {r.example && <p className="small" lang={lang}>{r.example}</p>}
          {r.example_translation && <p className="muted small">{r.example_translation}</p>}
          <button className="btn btn-ghost" disabled={added} onClick={add}>{t(added ? "lookup.inWords" : "lookup.add")}</button>
        </>}
    </div>,
    document.body);
}
