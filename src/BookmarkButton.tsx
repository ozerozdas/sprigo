// Bookmark toggle (#45): one button for units, guidebooks and stories, saved against the enrollment.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons";
import { useApp } from "./store";
import * as db from "./db";

export const BOOKMARKS_CHANGED = "sprigo:bookmarks";

export function BookmarkButton({ kind, target, title }: { kind: db.BookmarkKind; target: string; title: string }) {
  const { t } = useTranslation();
  const { enrollment, toast } = useApp();
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enrollment) return;
    const read = () => db.isBookmarked(enrollment.id, kind, target).then(setOn).catch((err) => console.error("bookmark", err));
    read();
    addEventListener(BOOKMARKS_CHANGED, read); // the same item can be on screen twice (guidebook sheet over the Saved list)
    return () => removeEventListener(BOOKMARKS_CHANGED, read);
  }, [enrollment?.id, kind, target]);
  if (!enrollment) return null;
  const label = t("bookmark.add", { item: title }); // stable name, aria-pressed says whether it's saved
  return (
    <button className="icon-btn bookmark-btn" aria-pressed={on} aria-label={label} title={label} onClick={(e) => {
      e.stopPropagation();
      db.toggleBookmark(enrollment.id, kind, target)
        .then((now) => { setOn(now); dispatchEvent(new Event(BOOKMARKS_CHANGED)); toast(t(now ? "bookmark.saved" : "bookmark.removed")); })
        .catch((err) => { console.error("bookmark", err); toast(t("bookmark.failed")); });
    }}>
      <Icon name={on ? "bookmarkOn" : "bookmark"} />
    </button>
  );
}
