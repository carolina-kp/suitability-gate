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
import { modelFor, spendOf, type Role, type TokenSpend } from "./config";

export class LLMError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LLMError";
  }
}

// --- Model split and spend -------------------------------------------------
//
// Both live in src/lib/config.ts: which model plays which role, and the rates
// that turn tokens into the cost shown on the verdict screen. Nothing here
// hard-codes either, so an arm is swapped by configuration rather than by
// editing this file.

/** Haiku 4.5 predates adaptive thinking, and takes a smaller default ceiling. */
function isThinkingModel(model: string): boolean {
  return !model.startsWith("claude-haiku");
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
  role: Role;
  /**
   * Overrides the configured model for this role, for this call only. Used by
   * the intake route so an arm can be swapped per request; every other caller
   * leaves it unset and takes the configured model.
   */
  model?: string;
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
  const model = opts.model ?? modelFor(opts.role);
  const label = opts.label ?? opts.role;

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
