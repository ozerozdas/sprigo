// Course YAML contract (docs/ARCHITECTURE.md §2) and the Learn-path view model built from it.
// Pure module (no Vite/Tauri imports) so `node --test` can run src/course.test.ts directly.
import { parse } from "yaml";
import { z } from "zod";

export const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Cefr = (typeof CEFR)[number];

// Canonical activity ids (PLAN §3.2). YAML only names the type; AI generates the content (DECISIONS B5).
export const ACTIVITY_TYPES = [
  "learn", "translate", "word_select", "match", "word_bank", "fill_blank", "multiple_choice",
  "listen_type", "listen_select", "image_select", "sentence_complete", "error_correct", "dialogue",
  "speak", "story", "roleplay", "video_call",
] as const;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");
// Extra keys (scenario, goal, text…) are kept as hints for the AI prompt.
const Activity = z.looseObject({
  type: z.enum(ACTIVITY_TYPES),
  count: z.int().min(1).max(10).optional(), // DECISIONS B6
});
const Step = z.strictObject({
  id: Id,
  title: z.string().min(1),
  description: z.string().optional(),
  vocabulary: z.array(z.string()).default([]),
  grammar: z.array(z.strictObject({ pattern: z.string() })).default([]),
  activities: z.array(Activity).min(1),
});
const Unit = z.strictObject({
  id: Id,
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  steps: z.array(Step).min(1),
});
const Level = z.strictObject({
  title: z.string().min(1),
  description: z.string().optional(),
  units: z.array(Unit).min(1),
  checkpoint: z.strictObject({
    title: z.string().min(1),
    required_score: z.number().min(0).max(100),
    activities: z.array(Activity).min(1),
  }).optional(),
});
const CourseSchema = z.strictObject({
  name: z.string().min(1),
  native_name: z.string().min(1),
  iso: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "ISO 639 code, e.g. en or pt-BR"),
  flag: z.string().optional(),
  levels: z.partialRecord(z.enum(CEFR), Level),
}).superRefine((c, ctx) => {
  if (!Object.keys(c.levels).length) ctx.addIssue({ code: "custom", path: ["levels"], message: "at least one CEFR level is required" });
  // Step ids key the progress table, so they must be unique across the whole course.
  const seen = new Set<string>();
  for (const [lv, level] of Object.entries(c.levels))
    level!.units.forEach((u, ui) => u.steps.forEach((s, si) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["levels", lv, "units", ui, "steps", si, "id"], message: `duplicate step id "${s.id}"` });
      seen.add(s.id);
    }));
});

export type Course = z.infer<typeof CourseSchema>;
export type CourseLevel = NonNullable<Course["levels"][Cefr]>;

/** Parses course YAML; throws an Error whose message names the file and the offending path/line. */
export function parseCourse(text: string, source: string): Course {
  let data: unknown;
  try { data = parse(text, { uniqueKeys: true }); }
  catch (e) { throw new Error(`${source}: ${(e as Error).message}`); }
  const r = CourseSchema.safeParse(data);
  if (!r.success) throw new Error(`${source}:\n${z.prettifyError(r.error)}`);
  return r.data;
}

export const levelsOf = (c: Course) => CEFR.filter((l) => c.levels[l]);
/** Stories (#27) are `story:<level>:<unit>`: unit ids may repeat across levels. Before 1.9 they were `story:<unit>`. */
export const storyId = (level: Cefr, unit: string) => `story:${level}:${unit}`;
export function parseStoryId(id: string): { level: Cefr; unit: string } | null {
  const m = /^story:([A-C][12]):(.+)$/.exec(id);
  return m ? { level: m[1] as Cefr, unit: m[2] } : null;
}
/** A unit's bookmark ref (#45): `level:unit`, because unit ids may repeat across levels like story ids. */
export const unitRef = (level: Cefr, unit: string) => `${level}:${unit}`;
export function parseUnitRef(ref: string): { level: Cefr; unit: string } | null {
  const m = /^([A-C][12]):(.+)$/.exec(ref);
  return m ? { level: m[1] as Cefr, unit: m[2] } : null;
}
/** "A1" or "A1–C1": shown in the course picker so an A1-only course says so up front. */
export const levelRange = (c: Course) => { const l = levelsOf(c); return l.length > 1 ? `${l[0]}–${l[l.length - 1]}` : l[0]; };

// ---- Learn path (DECISIONS B8): only one level's units; chest after each unit, checkpoint last. ----

export type NodeState = "done" | "current" | "locked";
export type PathNode = { id: string; kind: "step" | "chest" | "checkpoint"; title: string; state: NodeState };
export type PathUnit = { id: string; index: number; title: string; nodes: PathNode[] };

export const chestId = (unitId: string) => `${unitId}:chest`;
export const checkpointId = (level: Cefr) => `${level}:checkpoint`;

/** `done` = step/chest ids from step_progress. Steps unlock in order; a chest opens once its unit is done. */
export function buildPath(level: CourseLevel, lv: Cefr, done: Set<string>): { units: PathUnit[]; remaining: number } {
  let current = false, remaining = 0;
  const units = level.units.map((u, i): PathUnit => {
    const nodes: PathNode[] = u.steps.map((s) => {
      let state: NodeState = "locked";
      if (done.has(s.id)) state = "done";
      else { remaining++; if (!current) { current = true; state = "current"; } }
      return { id: s.id, kind: "step", title: s.title, state };
    });
    const unitDone = nodes.every((n) => n.state === "done");
    nodes.push({ id: chestId(u.id), kind: "chest", title: "", state: done.has(chestId(u.id)) ? "done" : unitDone ? "current" : "locked" });
    return { id: u.id, index: i + 1, title: u.title, nodes };
  });
  if (level.checkpoint) {
    const id = checkpointId(lv);
    units[units.length - 1].nodes.push({ id, kind: "checkpoint", title: level.checkpoint.title, state: done.has(id) ? "done" : remaining ? "locked" : "current" });
  }
  return { units, remaining };
}
