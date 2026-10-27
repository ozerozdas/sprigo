// Local multi-profile (DECISIONS E4–E5). Not in the design: built from its cards, avatars and sheet.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../icons";
import { useApp } from "../store";
import { languages } from "../i18n";
import * as db from "../db";
import type { Profile } from "../db";
import { levelRange, type Course } from "../course";

const COLORS = ["#12b886", "#4c6ef5", "#b07cf0", "#f4862a", "#e91e63", "#00b8a9", "#f5b014", "#5c6bc0"];
// ponytail: fixed list of native languages the AI can translate into; extend when someone asks.
export const NATIVE = ["en", "tr", "de", "fr", "es", "hu", "pl", "it", "pt", "ru", "ar", "ja", "ko", "zh"];
const gap = (g: string) => ({ "--od-gap": g }) as React.CSSProperties;

export function useLangName() {
  const { i18n } = useTranslation();
  const dn = new Intl.DisplayNames([i18n.language], { type: "language" });
  return (iso: string) => { const n = dn.of(iso) ?? iso; return n[0].toLocaleUpperCase(i18n.language) + n.slice(1); };
}

export const Avatar = ({ p, size = 48 }: { p: Pick<Profile, "name" | "color">; size?: number }) => (
  <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: p.color }} aria-hidden="true">{(p.name || "?")[0].toUpperCase()}</span>
);

export function CourseFlag({ c }: { c: Course }) {
  return <span aria-hidden="true">{c.flag ?? c.iso.toUpperCase()}</span>;
}

/** Create (no `initial`) or edit the signed-in profile. */
export function ProfileForm({ initial, onDone }: { initial?: Profile; onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const { courses, theme, createProfile, updateProfile, toast } = useApp();
  const langName = useLangName();
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? COLORS[0]);
  const [native, setNative] = useState(initial?.native_lang ?? (NATIVE.includes(i18n.language) ? i18n.language : "en"));
  const [courseIso, setCourseIso] = useState(courses.find((c) => c.iso !== native)?.iso ?? courses[0]?.iso ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && /^(\d{4})?$/.test(pin) && (initial || courseIso);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (initial) {
        await updateProfile({ name: name.trim(), color, ...(pin ? { pin } : {}) });
        toast(t("profiles.saved"));
      } else {
        await createProfile({ name: name.trim(), color, native_lang: native, ui_lang: i18n.language, theme, pin: pin || null }, courseIso);
      }
      onDone?.();
    } finally { setBusy(false); }
  };

  return (
    <form className="od-stack" style={gap("14px")} onSubmit={submit}>
      <div className="od-row" style={gap("14px")}>
        <Avatar p={{ name, color }} size={56} />
        <label className="od-field od-fill"><b>{t("profiles.name")}</b>
          <input className="input" value={name} maxLength={24} autoFocus required onChange={(e) => setName(e.target.value)} placeholder={t("profiles.namePlaceholder")} />
        </label>
      </div>
      <div className="od-field"><b>{t("profiles.color")}</b>
        <div className="od-cluster" role="radiogroup" aria-label={t("profiles.color")} style={gap("8px")}>
          {COLORS.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={c === color} aria-label={c} className="swatch" style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      {!initial && (
        <label className="od-field"><b>{t("settings.language")}</b>
          <select className="select" value={i18n.resolvedLanguage} onChange={(e) => i18n.changeLanguage(e.target.value)}>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
      )}
      {!initial && (
        <label className="od-field"><b>{t("profiles.native")}</b><span className="muted small">{t("profiles.nativeDesc")}</span>
          <select className="select" value={native} onChange={(e) => setNative(e.target.value)}>
            {NATIVE.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
          </select>
        </label>
      )}
      {!initial && (
        <label className="od-field"><b>{t("profiles.course")}</b>
          <select className="select" value={courseIso} onChange={(e) => setCourseIso(e.target.value)}>
            {courses.map((c) => <option key={c.iso} value={c.iso}>{c.flag} {langName(c.iso)} · {levelRange(c)}</option>)}
          </select>
          {!courses.length && <span className="small" style={{ color: "var(--red)" }}>{t("profiles.noCourses")}</span>}
        </label>
      )}
      <label className="od-field"><b>{t(initial?.pin_hash ? "profiles.pinChange" : "profiles.pin")}</b><span className="muted small">{t("profiles.pinDesc")}</span>
        <input className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="••••" style={{ maxWidth: 140, letterSpacing: 6 }} />
      </label>
      {initial?.pin_hash && (
        <button type="button" className="btn btn-ghost" onClick={async () => { await updateProfile({ pin: null }); toast(t("profiles.pinRemoved")); onDone?.(); }}>
          {t("profiles.pinRemove")}
        </button>
      )}
      <button className="btn btn-primary btn-block" disabled={!valid || busy}>{t(initial ? "profiles.save" : "profiles.create")}</button>
      {onDone && <button type="button" className="btn btn-ghost btn-block" onClick={onDone}>{t("sheet.cancel")}</button>}
    </form>
  );
}

/** `onOk` replaces the sign-in, for reusing the check before a destructive action. */
function PinSheet({ p, onOk }: { p: Profile; onOk?: () => void }) {
  const { t } = useTranslation();
  const { login, closeSheet } = useApp();
  const [pin, setPin] = useState("");
  const [wrong, setWrong] = useState(false);
  const change = async (v: string) => {
    v = v.replace(/\D/g, "").slice(0, 4);
    setPin(v); setWrong(false);
    if (v.length < 4) return;
    if (await db.checkPin(p, v)) { if (onOk) onOk(); else { closeSheet(); await login(p); } }
    else { setWrong(true); setPin(""); }
  };
  return <>
    <div className="od-row" style={gap("12px")}><Avatar p={p} /><h3>{t("profiles.enterPin", { name: p.name })}</h3></div>
    <input className="input" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin} aria-label={t("profiles.pin")}
      onChange={(e) => change(e.target.value)} placeholder="••••" style={{ margin: "16px 0 8px", width: "100%", textAlign: "center", fontSize: 24, letterSpacing: 12 }} />
    <p className="small" role="alert" style={{ color: "var(--red)", minHeight: 20 }}>{wrong ? t("profiles.pinWrong") : ""}</p>
    <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
  </>;
}

function DeleteSheet({ p, onDeleted }: { p: Profile; onDeleted: () => void }) {
  const { t } = useTranslation();
  const { closeSheet, toast } = useApp();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try { await db.deleteProfile(p.id); closeSheet(); onDeleted(); toast(t("profiles.deleted", { name: p.name })); }
    catch (e) { console.error(e); toast(t("profiles.deleteFailed")); }
    finally { setBusy(false); }
  };
  return <>
    <div className="od-row" style={gap("12px")}><Avatar p={p} /><h3>{t("profiles.deleteTitle", { name: p.name })}</h3></div>
    <p style={{ margin: "14px 0" }}>{t("profiles.deleteWarn", { name: p.name })}</p>
    <label className="od-field"><b>{t("profiles.deleteType", { name: p.name })}</b>
      <input className="input" value={typed} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
    </label>
    <div className="od-stack" style={{ ...gap("10px"), marginTop: 16 }}>
      <button className="btn btn-danger btn-block" disabled={busy || typed !== p.name} onClick={remove}>{t("profiles.delete")}</button>
      <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
    </div>
  </>;
}

/** Shown when nobody is signed in: pick a profile or create one. */
export function ProfileGate() {
  const { t } = useTranslation();
  const { login, openSheet } = useApp();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const refresh = () => db.listProfiles().then(setProfiles);
  useEffect(() => { refresh(); }, []);
  if (!profiles) return null;
  const askDelete = (p: Profile) => {
    setMenu(null);
    const dialog = <DeleteSheet p={p} onDeleted={refresh} />;
    openSheet(p.pin_hash ? <PinSheet p={p} onOk={() => openSheet(dialog)} /> : dialog);
  };
  const create = creating || profiles.length === 0;
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "48px 16px" }}>
      <div className="logo" style={{ textAlign: "center", marginBottom: 12 }}>sprigo</div>
      <h1 className="section-title" style={{ textAlign: "center", marginTop: 0 }}>{t(create ? (profiles.length ? "profiles.newTitle" : "profiles.welcome") : "profiles.who")}</h1>
      {create ? (
        <div className="card"><ProfileForm onDone={profiles.length ? () => setCreating(false) : undefined} /></div>
      ) : (
        <div className="od-stack" style={gap("12px")}>
          {profiles.map((p) => (
            <div key={p.id} className="card od-row" style={{ ...gap("4px"), padding: 4 }}>
              <button className="row-item od-fill" onClick={() => p.pin_hash ? openSheet(<PinSheet p={p} />) : login(p)}>
                <Avatar p={p} />
                <span className="od-field od-fill"><b>{p.name}</b></span>
                {p.pin_hash && <span className="muted" aria-label={t("profiles.locked")} style={{ width: 22, height: 22, display: "inline-flex" }}><Icon name="lock" size={22} /></span>}
              </button>
              {/* ponytail: WebKit (Tauri on macOS) doesn't focus clicked buttons, so the menu keeps focus on mousedown or it closes before the click lands */}
              <div className="menu-wrap" onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setMenu(null)}>
                <button className="btn btn-ghost" aria-label={t("profiles.more", { name: p.name })} aria-haspopup="menu" aria-expanded={menu === p.id}
                  onClick={() => setMenu(menu === p.id ? null : p.id)}>⋯</button>
                {menu === p.id && <div className="menu" role="menu" onMouseDown={(e) => e.preventDefault()}><button role="menuitem" className="menu-item danger" autoFocus onClick={() => askDelete(p)}>{t("profiles.delete")}</button></div>}
              </div>
            </div>
          ))}
          <button className="btn btn-ghost btn-block" onClick={() => setCreating(true)}>+ {t("profiles.add")}</button>
        </div>
      )}
    </main>
  );
}

/** Enrolled courses + "add a language" (DECISIONS E5). Opened from the rail flag chip and Settings. */
export function CourseSheet() {
  const { t } = useTranslation();
  const { courses, enrollments, enrollment, switchCourse, closeSheet, toast } = useApp();
  const langName = useLangName();
  const pick = async (c: Course) => {
    await switchCourse(c.iso);
    closeSheet();
    toast(t("profiles.switched", { course: langName(c.iso) }));
  };
  const enrolled = enrollments.map((e) => ({ e, c: courses.find((c) => c.iso === e.course_iso) })).filter((x) => x.c);
  const others = courses.filter((c) => !enrollments.some((e) => e.course_iso === c.iso));
  return <>
    <h3>{t("profiles.myCourses")}</h3>
    <div className="od-stack" style={{ ...gap("10px"), margin: "12px 0 18px" }}>
      {enrolled.map(({ e, c }) => (
        <button key={e.id} className="card row-item" onClick={() => pick(c!)} aria-current={e.id === enrollment?.id}>
          <span style={{ fontSize: 28 }}><CourseFlag c={c!} /></span>
          <span className="od-field od-fill"><b>{langName(c!.iso)}</b><span className="muted small">{e.level} · {e.xp} XP</span></span>
          {e.id === enrollment?.id && <span style={{ color: "var(--green)", width: 24, height: 24, display: "inline-flex" }}><Icon name="check" size={24} /></span>}
        </button>
      ))}
    </div>
    <h3>{t("profiles.addCourse")}</h3>
    <div className="od-stack" style={{ ...gap("10px"), margin: "12px 0 18px" }}>
      {others.length ? others.map((c) => (
        <button key={c.iso} className="card row-item" onClick={() => pick(c)}>
          <span style={{ fontSize: 28 }}><CourseFlag c={c} /></span>
          <span className="od-field od-fill"><b>{langName(c.iso)}</b><span className="muted small">{c.native_name} · {levelRange(c)}</span></span>
          <span className="btn btn-ghost" style={{ pointerEvents: "none" }}>{t("profiles.start")}</span>
        </button>
      )) : <p className="muted small">{t("profiles.noMoreCourses")}</p>}
    </div>
    <button className="btn btn-ghost btn-block" onClick={closeSheet}>{t("sheet.cancel")}</button>
  </>;
}
