// Pure system-voice picking by gender (tested by src/voices.test.ts). Names are macOS voices.
type V = { name: string; lang: string };
/** Preferred first. macOS (Samantha, Daniel; the newer Eddy/Reed/Rocko/Flo/Sandy/Shelley ship in many languages) and Windows ("Microsoft David - English …"). */
const ANY = { f: ["Flo", "Sandy", "Shelley", "Grandma"], m: ["Reed", "Eddy", "Rocko", "Grandpa"] };
const NAMES: Record<string, { f: string[]; m: string[] }> = {
  en: { f: ["Samantha", "Ava", "Allison", "Susan", "Karen", "Moira", "Tessa", "Serena", "Victoria", "Kathy", "Aria", "Jenny", "Zira", "Hazel"], m: ["Daniel", "Alex", "Tom", "Oliver", "Evan", "Guy", "Ryan", "David", "Mark", "George", ...ANY.m, "Aman", "Rishi", "Fred", "Ralph"] },
  tr: { f: ["Yelda", "Emel", "Seda"], m: ["Tolga", "Ahmet", "Cem"] },
  de: { f: ["Anna", "Petra", "Helena", "Katja", "Hedda"], m: ["Markus", "Yannick", "Conrad", "Stefan"] },
  es: { f: ["Monica", "Mónica", "Paulina", "Marisol", "Elvira", "Helena", "Laura"], m: ["Jorge", "Diego", "Juan", "Alvaro", "Pablo"] },
  fr: { f: ["Amelie", "Amélie", "Audrey", "Marie", "Denise", "Julie", "Hortense"], m: ["Thomas", "Daniel", "Nicolas", "Jacques", "Henri", "Paul"] },
  hu: { f: ["Tünde", "Mariska", "Noemi"], m: ["Szabolcs", "Tamas"] },
};
const has = (voice: string, name: string) => new RegExp(`(^|[\\s(])${name}([\\s(-]|$)`, "i").test(voice);

/** The most preferred installed voice of `gender`, else the language's first voice with a pitch shift.
 *  `accent` (e.g. "en-GB") keeps to that region's voices when any are installed. */
export function pickSystemVoice<T extends V>(voices: T[], lang: string, gender?: "f" | "m", accent?: string): { voice?: T; pitch: number } {
  const code = lang.slice(0, 2).toLowerCase();
  const all = voices.filter((v) => v.lang.slice(0, 2).toLowerCase() === code);
  const region = accent && all.filter((v) => v.lang.replace("_", "-").toLowerCase() === accent.toLowerCase());
  const ofLang = region && region.length ? region : all;
  if (!gender) return { voice: ofLang[0], pitch: 1 };
  const wanted = [...(NAMES[code]?.[gender] ?? []), ...ANY[gender]];
  for (const n of wanted) {
    const hit = ofLang.find((v) => has(v.name, n));
    if (hit) return { voice: hit, pitch: 1 };
  }
  return { voice: ofLang[0], pitch: gender === "f" ? 1.15 : 0.8 };
}
