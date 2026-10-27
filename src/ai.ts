// AI providers (DECISIONS C1). Config is device-wide (E6): device_settings "ai" + API key in the OS keychain.
import { generateText, NoObjectGeneratedError, Output, streamText, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { isTauri, isCompanion, getSetting, setSetting } from "./db";
import { retry, withBackup } from "./retry";

export type ProviderId = "ollama" | "lmstudio" | "openai" | "anthropic" | "gemini" | "openrouter";
export const PROVIDERS: Record<ProviderId, { label: string; baseURL: string; needsKey: boolean }> = {
  ollama: { label: "Ollama", baseURL: isCompanion ? `${location.origin}/ollama` : "http://localhost:11434", needsKey: false },
  lmstudio: { label: "LM Studio", baseURL: "http://localhost:1234/v1", needsKey: false },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", needsKey: true },
  anthropic: { label: "Anthropic", baseURL: "https://api.anthropic.com/v1", needsKey: true },
  gemini: { label: "Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta", needsKey: true },
  openrouter: { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", needsKey: true },
};
export type AiConfig = { provider: ProviderId; baseURL: string; model: string };

// Tauri's HTTP plugin sidesteps CORS for local servers and cloud APIs; the dev browser preview uses window.fetch.
const http = (isTauri ? tauriFetch : window.fetch.bind(window)) as typeof fetch;
const trim = (u: string) => u.replace(/\/+$/, "");
// The saved config is the desktop's (shared database), so on the phone its localhost address means the proxy.
const baseOf = (c: AiConfig) => trim(isCompanion && c.provider === "ollama" ? PROVIDERS.ollama.baseURL : c.baseURL || PROVIDERS[c.provider].baseURL);

export async function loadAiConfig(): Promise<AiConfig | null> {
  const v = await getSetting("ai");
  return v ? JSON.parse(v) : null;
}
export const saveAiConfig = (c: AiConfig) => setSetting("ai", JSON.stringify(c));
/** Backup provider (#36): asked when the main one fails. Only one the learner set up, never chosen for them (privacy). */
export async function loadAiBackup(): Promise<AiConfig | null> {
  const v = await getSetting("ai.backup");
  return v ? JSON.parse(v) : null;
}
export const saveAiBackup = (c: AiConfig | null) => setSetting("ai.backup", c && JSON.stringify(c));

// ---- API keys ----
// ponytail: the dev browser preview has no keychain, so it keeps keys in localStorage. Never used in the app.
const DEV_KEY = (p: ProviderId) => `sprigo.devkey.${p}`;
export async function getKey(p: ProviderId): Promise<string | null> {
  if (!PROVIDERS[p].needsKey) return null;
  return isTauri ? invoke<string | null>("secret_get", { key: `api-key.${p}` }) : localStorage.getItem(DEV_KEY(p));
}
export async function setKey(p: ProviderId, value: string | null) {
  if (isTauri) return invoke("secret_set", { key: `api-key.${p}`, value });
  value ? localStorage.setItem(DEV_KEY(p), value) : localStorage.removeItem(DEV_KEY(p));
}

// ---- Models ----

// OpenRouter: thinking off (`reasoning.effort: "none"`). Models where it is mandatory answer 400, so they are asked
// again with "minimal" and remembered for the session.
const mustReason = new Set<string>();
const openrouterFetch: typeof fetch = async (url, init) => {
  if (typeof init?.body !== "string") return http(url, init);
  const body = JSON.parse(init.body);
  const send = (effort: string) => http(url, { ...init, body: JSON.stringify({ ...body, reasoning: { effort } }) });
  if (mustReason.has(body.model)) return send("minimal");
  const r = await send("none");
  if (r.status !== 400 || !/reasoning/i.test(await r.clone().text())) return r;
  mustReason.add(body.model);
  return send("minimal");
};

function model(c: AiConfig, key: string | null): LanguageModel {
  const baseURL = baseOf(c);
  const apiKey = key ?? "";
  switch (c.provider) {
    // Ollama and LM Studio both speak the OpenAI chat API with json_schema structured output.
    case "ollama": return createOpenAICompatible({ name: "ollama", baseURL: `${baseURL}/v1`, fetch: http, supportsStructuredOutputs: true }).chatModel(c.model);
    case "lmstudio": return createOpenAICompatible({ name: "lmstudio", baseURL, fetch: http, supportsStructuredOutputs: true }).chatModel(c.model);
    case "openai": return createOpenAI({ apiKey, baseURL, fetch: http })(c.model);
    case "anthropic": return createAnthropic({ apiKey, baseURL, fetch: http, headers: { "anthropic-dangerous-direct-browser-access": "true" } })(c.model);
    case "gemini": return createGoogle({ apiKey, baseURL, fetch: http })(c.model);
    // Compatible, not createOpenAI: that one may use the Responses API, which OpenRouter's chat models don't all speak.
    case "openrouter": return createOpenAICompatible({ name: "openrouter", baseURL, apiKey, fetch: openrouterFetch, supportsStructuredOutputs: true }).chatModel(c.model);
  }
}

/** Model ids offered by the provider; throws with the server's message when unreachable/unauthorized. */
export async function listModels(c: AiConfig, key: string | null): Promise<string[]> {
  const base = baseOf(c);
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await http(url, { headers });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  switch (c.provider) {
    case "ollama": return (await get(`${base}/api/tags`)).models.map((m: any) => m.name);
    case "lmstudio": return (await get(`${base}/models`)).data.map((m: any) => m.id);
    case "openai": case "openrouter": return (await get(`${base}/models`, { Authorization: `Bearer ${key}` })).data.map((m: any) => m.id).sort();
    case "anthropic": return (await get(`${base}/models`, { "x-api-key": key ?? "", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" })).data.map((m: any) => m.id);
    case "gemini": return (await get(`${base}/models?key=${encodeURIComponent(key ?? "")}`)).models
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent")).map((m: any) => m.name.replace(/^models\//, ""));
  }
}

// Thinking models (e.g. glm on Ollama) otherwise reason for minutes; exercises need little. Measured: 185 s → 7 s.
// Ollama models get "none": even "low" thinks 400–3500 tokens per tutor turn (pnpm bench, M4). First sentence with "none":
// gemma4:e2b 5 s → 0.4 s, qwen3.5:4b 2 min → 0.9 s, kimi-k2.6:cloud 31 s → 1.4 s, deepseek-v4-pro:cloud 3.1 s → 0.5 s.
// Except glm-5.3-flash:cloud: with "none" it writes its reasoning into the reply itself (SPR-14, 213 tokens vs 44; 2.2 s vs 0.5 s).
// LM Studio gets "none" too: with any other effort, or none sent, qwen3.8 there puts the whole structured reply in
// reasoning_content and leaves the answer empty, so every lesson failed. gpt-oss, which has no off level, accepts it too.
// ponytail: one named exception; a per-model setting if more models behave like glm-5.3-flash.
const reasoning = (c: AiConfig) =>
  c.provider === "ollama" ? (c.model.startsWith("glm-5.3-flash") ? "low" as const : "none" as const)
  : c.provider === "lmstudio" ? "none" as const : undefined;

type Active = { cfg: AiConfig; key: string | null };
let active: Active | null = null, backup: Active | null = null;
let onSwitch = (_from: AiConfig, _to: AiConfig) => {};
/** Called when a request moves from the main provider to the backup, e.g. to tell the learner. */
export const onBackupUsed = (f: (from: AiConfig, to: AiConfig) => void) => { onSwitch = f; };
// ponytail: one backup, an ordered list in Settings if people want more. Any failure switches: the lesson would fail anyway.
const viaBackup = <T>(cfg: Active | null, fn: (c: Active) => Promise<T>, may?: () => boolean) => {
  if (!cfg) throw new Error("AI provider is not set up");
  const b = cfg === active ? backup : null; // explicit configs (bench, eval, tests) never switch
  return withBackup(cfg, b, fn, (to) => onSwitch(cfg.cfg, to.cfg), may);
};

/** Loads a local Ollama model before a live call so the first turn is not a cold start (SPR-14). Cloud models answer at once. */
export function warmUp() {
  if (active?.cfg.provider !== "ollama") return;
  const base = baseOf(active.cfg);
  http(`${base}/api/generate`, { method: "POST", body: JSON.stringify({ model: active.cfg.model, keep_alive: "10m" }) }).catch(() => {});
}
export async function activateConfig(cfg: AiConfig | null, backupCfg: AiConfig | null = null) {
  active = cfg && { cfg, key: await getKey(cfg.provider) };
  backup = cfg && backupCfg && backupCfg.provider !== cfg.provider ? { cfg: backupCfg, key: await getKey(backupCfg.provider) } : null;
}

/** Pulls the JSON object out of replies wrapped in ```json fences or prose. */
export function extractJson(text: string): unknown {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON object in the reply");
  return JSON.parse(text.slice(a, b + 1));
}

/** Structured generation with the active provider. `loose` parses replies the strict `schema` rejected
 *  (e.g. fills a field the model left out); the schema sent to the provider stays strict for OpenAI's strict mode.
 *  `seconds`: a call the caller can do without (the second look at a lesson) gets one try, no backup, and that long. */
export async function generate<S extends z.ZodType>(schema: S, system: string, prompt: string, cfg = active, loose: z.ZodType = schema, seconds?: number): Promise<z.infer<S>> {
  return viaBackup(cfg, (c) => generateWith(schema, system, prompt, c, loose, seconds), seconds ? () => false : undefined);
}
async function generateWith<S extends z.ZodType>(schema: S, system: string, prompt: string, cfg: Active, loose: z.ZodType, seconds?: number): Promise<z.infer<S>> {
  // Some servers ignore response_format (e.g. Ollama cloud models), so the schema is in the prompt too.
  system += `\n\nJSON schema of the reply:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  const once = async () => {
    try {
      const r = await generateText({
        model: model(cfg.cfg, cfg.key), reasoning: reasoning(cfg.cfg), system, prompt, maxRetries: 1,
        output: Output.object({ schema }),
        abortSignal: AbortSignal.timeout((seconds ?? 180) * 1000),
      });
      return r.output as z.infer<S>;
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e) || !e.text) throw e;
      return loose.parse(extractJson(e.text)) as z.infer<S>; // lenient retry on fenced / chatty replies
    }
  };
  // Models sometimes drop a field or break the JSON; ask again. Network, auth and timeouts fail at once.
  // ponytail: fixed 3 tries; per-provider setting if a slow model makes this too long
  return retry(once, badReply, seconds ? 1 : 3);
}

/** `generate`, streamed (SPR-13): `onText` sees the raw reply as it grows and returns true once it acted on it
 *  (e.g. started speaking). After that a broken reply is not asked again: `loose` fills what it can from `{}`. */
export async function generateStream<S extends z.ZodType>(schema: S, system: string, prompt: string, onText: (raw: string) => boolean,
  loose: z.ZodType = schema, cfg = active): Promise<z.infer<S>> {
  let spoke = false; // once a reply was acted on, a second provider would say it all again
  return viaBackup(cfg, (c) => streamWith(schema, system, prompt, (raw) => onText(raw) && (spoke = true), loose, c), () => !spoke);
}
async function streamWith<S extends z.ZodType>(schema: S, system: string, prompt: string, onText: (raw: string) => boolean,
  loose: z.ZodType, cfg: Active): Promise<z.infer<S>> {
  system += `\n\nJSON schema of the reply:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  let used = false;
  const once = async () => {
    let failed: unknown, text = "";
    const r = streamText({
      model: model(cfg.cfg, cfg.key), reasoning: reasoning(cfg.cfg), system, prompt, maxRetries: 1,
      output: Output.object({ schema }),
      abortSignal: AbortSignal.timeout(180_000),
      onError: ({ error }) => { failed = error; },
    });
    for await (const d of r.textStream) { text += d; if (onText(text)) used = true; }
    if (failed) throw failed;
    try {
      return (await r.output) as z.infer<S>;
    } catch {
      try { return loose.parse(extractJson(text)) as z.infer<S>; }
      catch (e) { if (used) return loose.parse({}) as z.infer<S>; throw e; } // already speaking: keep going, don't ask again
    }
  };
  return retry(once, (e) => !used && badReply(e));
}

const badReply = (e: unknown) => NoObjectGeneratedError.isInstance(e) || e instanceof z.ZodError || e instanceof SyntaxError ||
  (e instanceof Error && e.message === "no JSON object in the reply");

export function generatePlain(system: string, prompt: string) {
  return viaBackup(active, async (c) => {
    const r = await generateText({ model: model(c.cfg, c.key), reasoning: reasoning(c.cfg), system, prompt, maxRetries: 1, abortSignal: AbortSignal.timeout(60_000) });
    return r.text.trim();
  });
}

/** First-run setup suggests this when Ollama runs without models. ponytail: one fixed pick, a size-aware list if people ask */
export const RECOMMENDED_OLLAMA = { model: "qwen3:8b", size: "5.2 GB" };

/** Local servers found on this Mac with their models (null = not running). */
export async function detectLocal(): Promise<Record<"ollama" | "lmstudio", string[] | null>> {
  const probe = (p: "ollama" | "lmstudio") => Promise.race([
    listModels({ provider: p, baseURL: PROVIDERS[p].baseURL, model: "" }, null),
    new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 2000)),
  ]).catch(() => null);
  const [ollama, lmstudio] = await Promise.all([probe("ollama"), probe("lmstudio")]);
  return { ollama, lmstudio };
}

/** Downloads a model into Ollama; onProgress gets 0..1. Throws with Ollama's error text. */
export async function pullOllama(baseURL: string, model: string, onProgress: (f: number) => void) {
  const r = await http(`${trim(baseURL)}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", big = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      // Progress is per layer; follow the biggest (the weights) so tiny config layers don't reset the bar.
      if (m.total && m.total >= big) { big = m.total; onProgress((m.completed ?? 0) / m.total); }
      if (m.status === "success") return;
    }
  }
  throw new Error("pull ended early");
}
