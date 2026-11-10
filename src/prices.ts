// Estimated list prices for cloud models, in USD per 1M input/output tokens (#48). Checked 2026-11-05 against:
// OpenAI https://platform.openai.com/docs/pricing · Anthropic https://platform.claude.com/docs/en/about-claude/pricing
// Gemini https://ai.google.dev/gemini-api/docs/pricing · OpenRouter https://openrouter.ai/api/v1/models
// A model missing here still counts its tokens; the UI shows no price for it. Prices change: treat this as an estimate.
export type ModelPrice = { input: number; output: number }; // USD per 1M tokens

const PRICES: Record<string, Record<string, ModelPrice>> = {
  openai: {
    "gpt-6-astra": { input: 10, output: 50 },
    "gpt-6.1-sol": { input: 2, output: 10 },
    "gpt-6.1-terra": { input: 1, output: 5 },
    "gpt-6-luna": { input: 0.1, output: 0.5 },
    "gpt-6-sol": { input: 2, output: 10 },
    "gpt-5.6-sol": { input: 4, output: 20 },
    "gpt-5.6-terra": { input: 2, output: 12 },
    "gpt-5.6-luna": { input: 0.2, output: 1.2 },
    "gpt-5.4": { input: 2.5, output: 15 }, // short context (≤272K input tokens)
    "gpt-5.4-mini": { input: 0.75, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, output: 1.25 },
    "gpt-5.2": { input: 1.75, output: 14 },
    "gpt-5.1": { input: 1.25, output: 10 },
    "gpt-5": { input: 1.25, output: 10 },
    "gpt-5-mini": { input: 0.25, output: 2 },
    "gpt-5-nano": { input: 0.05, output: 0.4 },
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    o3: { input: 2, output: 8 },
    "o3-pro": { input: 20, output: 80 },
  },
  anthropic: {
    "claude-fable-5.1": { input: 10, output: 50 },
    "claude-mythos-5.1": { input: 10, output: 50 },
    "claude-opus-5.5": { input: 4, output: 20 },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-4.8": { input: 5, output: 25 },
    "claude-opus-4.7": { input: 5, output: 25 },
    "claude-opus-4.6": { input: 5, output: 25 },
    "claude-opus-4.5": { input: 5, output: 25 },
    "claude-sonnet-5.5": { input: 2, output: 10 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-sonnet-4.6": { input: 3, output: 15 },
    "claude-sonnet-4.5": { input: 3, output: 15 },
    "claude-haiku-5.5": { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
    "claude-haiku-4.5": { input: 1, output: 5 },
  },
  gemini: {
    "gemini-4-argon": { input: 2, output: 10 }, // introductory price through 2026-11-30
    "gemini-3.8-flash": { input: 0.75, output: 3.75 }, // introductory price through 2026-12-31
    "gemini-3.6-flash": { input: 0.75, output: 3.75 },
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
    "gemini-3.1-pro-preview": { input: 2, output: 12 }, // prompts up to 200K tokens
    "gemini-3-flash-preview": { input: 0.5, output: 3 },
    "gemini-2.5-pro": { input: 1.25, output: 10 }, // deprecated; routes to 3.8 Flash from 2026-12-01
    "gemini-2.5-flash": { input: 0.3, output: 2.5 }, // deprecated; routes to 3.5 Flash-Lite from 2026-12-01
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  },
};

// OpenRouter ids carry their vendor: "openai/gpt-4o-mini" is priced from the vendor's own table. Its listed prices
// matched these for the models checked; a small routing margin, if any, is not included.
const VENDOR: Record<string, string> = { openai: "openai", anthropic: "anthropic", google: "gemini" };

/** The same model id seen with a `models/` prefix, a date suffix, a dot version or an OpenRouter vendor or `:tag`. */
const key = (model: string) => model.toLowerCase()
  .replace(/^[^/]+\//, "")
  .replace(/:[^:]+$/, "")
  .replace(/(-\d{4}-\d{2}-\d{2}|-\d{8})$/, "")
  .replace(/\./g, "-");

// Looked up by normalized id, so "claude-sonnet-4.5" and "claude-sonnet-4-5-20250929" find the same entry.
const TABLES = Object.fromEntries(Object.entries(PRICES).map(([p, table]) => [p, new Map(Object.entries(table).map(([m, price]) => [key(m), price]))]));

const FREE: ModelPrice = { input: 0, output: 0 };

/** Price of a provider's model, or null when the table has none. Ollama and LM Studio are local and free. */
export function priceOf(provider: string, model: string): ModelPrice | null {
  if (provider === "ollama" || provider === "lmstudio" || (provider === "openrouter" && /:free$/i.test(model))) return FREE;
  const table = TABLES[provider === "openrouter" ? VENDOR[model.split("/")[0].toLowerCase()] : provider];
  return table?.get(key(model)) ?? null;
}

/** Estimated USD for one call, or null when the model has no known price. */
export function costOf(provider: string, model: string, input: number, output: number): number | null {
  const p = priceOf(provider, model);
  return p && (input * p.input + output * p.output) / 1_000_000;
}
