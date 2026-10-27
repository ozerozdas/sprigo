import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NUDGES, SLOTS, nudgeDue, nudgeMessage, slotTimes } from "./nudge.ts";
import { NEW_STATS } from "./progress.ts";

const DAY = "2026-03-05";
const at = (h: number, m = 0) => new Date(2026, 2, 5, h, m);
const on = { ...NEW_STATS, reminderOn: true };

test("three slots a day, near 10:00 / 15:00 / 19:30, stable for the day", () => {
  for (const day of ["2026-03-05", "2026-03-29", "2026-10-25", "2026-12-31"]) {
    const ts = slotTimes(day);
    assert.deepEqual(ts, slotTimes(day));
    const [y, m, d] = day.split("-").map(Number);
    ts.forEach((t, i) => {
      const base = new Date(y, m - 1, d, 0, SLOTS[i]).getTime();
      assert.ok(Math.abs(t - base) <= 30 * 60_000, `${day} slot ${i}`);
      if (i) assert.ok(t > ts[i - 1]);
    });
  }
});

test("nudgeDue: the latest due slot, once, only on days without practice", () => {
  const [s0, s1, s2] = slotTimes(DAY);
  assert.equal(nudgeDue(on, new Date(s0 - 60_000)), null, "before the first slot");
  assert.equal(nudgeDue(on, new Date(s0)), 0);
  assert.equal(nudgeDue({ ...on, reminded: `${DAY}:0` }, new Date(s0 + 60_000)), null, "already sent");
  assert.equal(nudgeDue({ ...on, reminded: `${DAY}:0` }, new Date(s1)), 1);
  assert.equal(nudgeDue(on, new Date(s2)), 2, "missed slots don't pile up");
  assert.equal(nudgeDue({ ...on, reminded: `${DAY}:2` }, at(23, 59)), null);
  assert.equal(nudgeDue({ ...on, reminded: "2026-03-04:2" }, new Date(s0)), 0, "yesterday's send doesn't count");
  assert.equal(nudgeDue({ ...on, lastActive: DAY }, at(20)), null, "practiced today");
  assert.equal(nudgeDue(NEW_STATS, at(20)), null, "reminders off");
});

test("nudgeMessage: roots only with a streak, evening last call, no repeats in a day", () => {
  for (let d = 1; d <= 28; d++) {
    const day = `2026-02-${String(d).padStart(2, "0")}`;
    for (const streak of [0, 5]) {
      const picks = [0, 1, 2].map((slot) => nudgeMessage(slot, streak, day));
      picks.forEach(({ group, i }) => assert.ok(i >= 0 && i < NUDGES[group]));
      if (!streak) assert.ok(picks.every((p) => p.group === "general"));
      else assert.equal(picks[2].group, "evening");
      assert.equal(new Set(picks.map((p) => `${p.group}${p.i}`)).size, 3, day);
    }
  }
});

test("every locale has exactly NUDGES messages per group, each with a title and body", () => {
  for (const l of ["en", "tr", "de", "es", "fr", "hu"]) {
    const n = JSON.parse(readFileSync(new URL(`./locales/${l}.json`, import.meta.url), "utf8")).nudges;
    for (const [g, count] of Object.entries(NUDGES)) {
      assert.equal(n[g].length, count, `${l} ${g}`);
      for (const m of n[g]) assert.ok(m.t.trim() && m.b.trim(), `${l} ${g}`);
    }
  }
});
