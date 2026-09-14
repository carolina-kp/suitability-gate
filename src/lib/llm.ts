/**
 * Anthropic client wrapper.
 *
 * Ported from argus `core/argus_core/llm.py` (provider-agnostic `generate`,
 * `LLMError`, structured warn logs on failure) and `clients/base.py`
 * (exponential-backoff retry). Three deliberate departures, each because this
 * is an eval harness rather than a product path:
 *
 *   1. **No cross-provider fallback chain.** argus falls through gemini ->
 *      groq -> anthropic on failure. Here, silently answering with a different
 *      model would mean the number on the /gate screen describes a model that
 *      is not the model under test. We retry the *same* model and then fail
 *      loudly — the argus eval's own rule that "a broken run can never be
 *      mistaken for a 0% score", applied one level down.
 *   2. **No server-side refusal fallbacks** (`fallbacks: "default"`), for the
 *      same reason, plus a sharper one: with adversarial personas probing for
 *      product recommendations, a refusal is a *result*, possibly the correct
 *      one. Routing around it would corrupt the "no personal recommendation"
 *      criterion. `stop_reason: "refusal"` is surfaced, not swallowed.
 *   3. **Usage is captured before validation.** Tokens are spent whether or
 *      not the JSON comes back well-formed, so every call returns its spend
 *      even on the unhappy path.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type * as z from "zod/v4";
import type { TokenSpend } from "./schema";

export class LLMError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LLMError";
  }
}

// --- Model split ------------------------------------------------------------

/**
 * The model split.
 *
 * - persona: cheap and fast, plays the client. It only has to follow a script.
 * - agent:   the thing under test. Sonnet 5 rather than Opus, because a bank
 *            running retail suitability intake at scale would not put a
 *            frontier model on a questionnaire, and the gate should describe
 *            what would actually be deployed.
 * - judge:   Opus 5. Deliberately NOT the same model as the agent: a model
 *            grading its own output carries a self-preference bias that is a
 *            known and nameable weakness. Grading with the stronger model also
 *            means the judge is not the limiting factor.
 *
 * Overridable so a run can be repeated elsewhere, but these defaults are what
 * the numbers in the README were produced with.
 */
export const MODELS = {
  persona: process.env.PERSONA_MODEL ?? "claude-haiku-4-5",
  agent: process.env.AGENT_MODEL ?? "claude-sonnet-5",
  judge: process.env.JUDGE_MODEL ?? "claude-opus-5",
};

export type Tier = keyof typeof MODELS;

/** USD per million tokens. Cache reads bill at ~0.1x the input rate. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Haiku 4.5 predates adaptive thinking and rejects `output_config.effort`. */
function isThinkingModel(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

// --- Spend ------------------------------------------------------------------

export function emptySpend(): TokenSpend {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
  };
}

export function addSpend(a: TokenSpend, b: TokenSpend): TokenSpend {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

function spendOf(model: string, usage: Anthropic.Usage): TokenSpend {
  const price = PRICES[model];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // An unpriced model reports tokens with a zero cost rather than a wrong one.
  const cost = price
    ? (input * price.input +
        cacheRead * price.input * 0.1 +
        output * price.output) /
      1_000_000
    : 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cost_usd: cost,
  };
}

export function formatUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

// --- Transport --------------------------------------------------------------

let cached: Anthropic | null = null;

/** Lazy so that importing this module never requires a key to be present. */
function client(): Anthropic {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new LLMError(
        "ANTHROPIC_API_KEY is not set. Put it in .env.local (see .env.example).",
      );
    }
    cached = new Anthropic();
  }
  return cached;
}

const MAX_ATTEMPTS = 5;

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    return typeof err.status === "number" && err.status >= 500;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  let used = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    used = attempt;
    try {
      return await fn();
    } catch (err) {
      last = err;
      // A configuration fault (no key) is not a transient failure. Surface it
      // as-is rather than burying it under a retry count that never happened.
      if (err instanceof LLMError) throw err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      // Exponential backoff with jitter, capped — mirrors argus clients/base.py.
      const wait = Math.min(2 ** attempt, 60) * 1000 * (0.5 + Math.random());
      console.warn(
        `{"llm":"${label}","event":"retrying","attempt":${attempt},"wait_ms":${Math.round(wait)}}`,
      );
      await sleep(wait);
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  console.warn(`{"llm":"${label}","event":"call_failed","error":"${detail}"}`);
  const attempted = used === 1 ? "on its only attempt" : `after ${used} attempts`;
  throw new LLMError(`${label} failed ${attempted}: ${detail}`, { cause: last });
}

// --- Completion -------------------------------------------------------------

export interface Completion {
  text: string;
  spend: TokenSpend;
  /** `"refusal"` is surfaced here rather than routed around. */
  stop_reason: string | null;
  model: string;
}

export interface CompleteOptions {
  tier: Tier;
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  /**
   * When set, the response is requested as JSON matching this schema.
   *
   * Note what this does and does not buy: the structured-output format
   * enforces types, required keys and `additionalProperties: false`. It does
   * *not* enforce enum membership or numeric bounds — the SDK's Zod converter
   * relocates `enum`/`const` into the field description, where the model reads
   * them as guidance. Callers must still validate the parsed value (see
   * `parseProfile`).
   */
  format?: z.ZodType;
  /** Label used in the structured warn logs. */
  label?: string;
}

export async function complete(opts: CompleteOptions): Promise<Completion> {
  const model = MODELS[opts.tier];
  const label = opts.label ?? opts.tier;

  const response = await withRetry(label, () =>
    client().messages.create({
      model,
      max_tokens: opts.maxTokens ?? (isThinkingModel(model) ? 16000 : 2000),
      system: opts.system,
      messages: opts.messages,
      ...(opts.format
        ? { output_config: { format: zodOutputFormat(opts.format) } }
        : {}),
    }),
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    text,
    spend: spendOf(model, response.usage),
    stop_reason: response.stop_reason,
    model,
  };
}

/**
 * `complete` plus JSON.parse, keeping the spend on both paths.
 *
 * Returns `value: null` with an `error` instead of throwing, because a
 * malformed profile is a finding the harness must record, not an exception
 * that aborts the run.
 */
export async function completeJson(
  opts: CompleteOptions & { format: z.ZodType },
): Promise<Completion & { value: unknown; error: string | null }> {
  const done = await complete(opts);

  if (done.stop_reason === "refusal") {
    return { ...done, value: null, error: "model refused to answer" };
  }
  try {
    return { ...done, value: JSON.parse(done.text), error: null };
  } catch {
    const preview = done.text.slice(0, 120).replace(/\s+/g, " ");
    return {
      ...done,
      value: null,
      error: `response was not JSON — starts: "${preview}"`,
    };
  }
}
