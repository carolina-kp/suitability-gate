/**
 * The run configuration: which model plays which role, and what a token costs.
 *
 * Two things live here rather than in the code that uses them, for the same
 * reason the risk-band policy lives in one testable function: a number that
 * ends up on the verdict screen should be somewhere you can find it, diff it
 * and assert it.
 *
 *   - The model per role is a config value, not a constant baked into the
 *     call site, so an arm can be swapped without editing the harness.
 *   - The rates table is the only place cost is defined. An unpriced model
 *     does not quietly report $0.00 — `assertRatesKnown` refuses to start.
 *
 * This module imports nothing. The verdict screen can read it without pulling
 * in the API client, and the tests can assert it without a key.
 */

// --- Roles ------------------------------------------------------------------

// Agent first: it is the thing under test, and every per-role display reads
// in this order. The other two are the rig.
export const ROLES = ["agent", "persona", "judge"] as const;
export type Role = (typeof ROLES)[number];

const ENV_KEY: Record<Role, string> = {
  persona: "PERSONA_MODEL",
  agent: "AGENT_MODEL",
  judge: "JUDGE_MODEL",
};

/**
 * The arm this repo describes.
 *
 * - agent: Haiku 4.5. The thing under test. A bank running retail onboarding
 *   at scale deploys a small fast model on a questionnaire, so that is the
 *   realistic case to gate. It is also the harder case: if the policy split
 *   and the boundary hold on Haiku, they hold on anything above it.
 * - judge: Sonnet 5. Deliberately NOT the agent's model — a model grading its
 *   own output carries a self-preference bias — and a tier above it, so the
 *   judge is not the limiting factor.
 * - persona: Haiku 4.5. It only has to follow a script.
 *
 * Persona and agent share a model, which is a weaker version of the same
 * concern and is stated as a limit in CONTEXT.md rather than hidden: a client
 * played by the same model that is answering may be an unusually cooperative
 * conversational partner. It is not a grading relationship, which is the one
 * that would corrupt a score.
 */
export const DEFAULT_MODELS: Record<Role, string> = {
  persona: "claude-haiku-4-5",
  agent: "claude-haiku-4-5",
  judge: "claude-sonnet-5",
};

/**
 * Read at call time, not at import time, so a CLI flag can set the environment
 * before the first request and an arm swap needs no code change.
 */
export function modelFor(role: Role): string {
  const override = process.env[ENV_KEY[role]];
  return override && override.trim() !== ""
    ? override.trim()
    : DEFAULT_MODELS[role];
}

export function currentModels(): Record<Role, string> {
  return { persona: modelFor("persona"), agent: modelFor("agent"), judge: modelFor("judge") };
}

/** Used by the CLI flags (`--agent=claude-opus-5`) to swap an arm. */
export function setModel(role: Role, model: string): void {
  process.env[ENV_KEY[role]] = model;
}

// --- Rates ------------------------------------------------------------------

export interface Rate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * USD per million tokens, first-party Anthropic API rates.
 *
 * Verified against the current pricing table rather than recalled. Adding a
 * model to an arm means adding it here — `assertRatesKnown` will say so before
 * anything is spent, because a cost of $0.00 on a real run is exactly the kind
 * of plausible-looking number this project exists to refuse.
 */
export const RATES: Record<string, Rate> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cache reads bill at ~0.1x the input rate; cache writes at ~1.25x. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function rateFor(model: string): Rate | null {
  return RATES[model] ?? null;
}

/**
 * Fail before spending, not after reporting.
 *
 * Returns the models that have no rate. The eval runner treats a non-empty
 * result as fatal: a run whose cost cannot be computed would put a number on
 * the screen that is wrong in the direction of looking cheap.
 */
export function unpricedModels(models: string[]): string[] {
  return [...new Set(models)].filter((m) => rateFor(m) === null);
}

export function assertRatesKnown(models: string[]): void {
  const unpriced = unpricedModels(models);
  if (unpriced.length > 0) {
    throw new Error(
      `No rate for ${unpriced.join(", ")}. Add it to RATES in src/lib/config.ts — ` +
        `a run whose cost cannot be computed must not report one.`,
    );
  }
}

// --- Spend ------------------------------------------------------------------

export interface TokenSpend {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Tokens billed by a model with no entry in RATES. Should always be 0. */
  unpriced_tokens: number;
  /** USD, from the rates table above. */
  cost_usd: number;
}

/** The shape of `usage` this module needs, without importing the SDK. */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function emptySpend(): TokenSpend {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    unpriced_tokens: 0,
    cost_usd: 0,
  };
}

export function addSpend(a: TokenSpend, b: TokenSpend): TokenSpend {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    unpriced_tokens: a.unpriced_tokens + b.unpriced_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

export function spendOf(model: string, usage: UsageLike): TokenSpend {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const rate = rateFor(model);

  const billable = input + output + cacheRead + cacheWrite;
  const cost = rate
    ? (input * rate.input +
        cacheRead * rate.input * CACHE_READ_MULTIPLIER +
        cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
        output * rate.output) /
      1_000_000
    : 0;

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    unpriced_tokens: rate ? 0 : billable,
    cost_usd: cost,
  };
}

// --- Spend, per role --------------------------------------------------------

/**
 * Every run carries its spend split by role, because one aggregate number
 * cannot answer the question the split exists for: what does the *agent*
 * cost, separately from the client simulator and the judge, which are test
 * apparatus and would not exist in production.
 */
export type RoleSpend = Record<Role, TokenSpend>;

export function emptyRoleSpend(): RoleSpend {
  return { persona: emptySpend(), agent: emptySpend(), judge: emptySpend() };
}

export function addToRole(
  base: RoleSpend,
  role: Role,
  spend: TokenSpend,
): RoleSpend {
  return { ...base, [role]: addSpend(base[role], spend) };
}

export function addRoleSpend(a: RoleSpend, b: RoleSpend): RoleSpend {
  return {
    persona: addSpend(a.persona, b.persona),
    agent: addSpend(a.agent, b.agent),
    judge: addSpend(a.judge, b.judge),
  };
}

export function totalSpend(rs: RoleSpend): TokenSpend {
  return ROLES.reduce((acc, role) => addSpend(acc, rs[role]), emptySpend());
}

/**
 * What one conversation costs to run in production terms: the agent only.
 * The persona simulator is the test rig and the judge is the scorer; neither
 * exists when a real client is on the other end.
 */
export function conversationSpend(rs: RoleSpend): TokenSpend {
  return rs.agent;
}

// --- Formatting -------------------------------------------------------------

export function formatUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Two costs shown in the same breath, at one precision.
 *
 * `formatUsd` switches to four decimals under a cent, which makes "$0.0087"
 * and "$0.01" look like they came off different instruments when they are
 * being compared to each other.
 */
export function formatUsdPair(a: number, b: number): [string, string] {
  const fine = a < 0.01 || b < 0.01;
  const fmt = (n: number) => (fine ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  return [fmt(a), fmt(b)];
}
