#!/usr/bin/env tsx
/**
 * Suitability-gate eval runner.
 *
 * For each persona in fixtures/personas/, a cheap model plays the client
 * against the live intake route for a full conversation, the transcript is
 * saved, and the final JSON profile is captured. The runner then hands every
 * run to the judge and writes results/<version>.json.
 *
 * Two things it deliberately will not do, both inherited from the argus eval:
 *
 *   * It talks to the app over HTTP rather than importing the agent. What gets
 *     scored is the deployed route, not a library function that happens to sit
 *     next to it. Start the app with `npm run dev` first.
 *   * It exits non-zero if the app is unreachable, so a broken run can never be
 *     mistaken for a bad score. A 0% that is really a connection refused is the
 *     one output that would make this whole exercise a lie.
 *
 * Usage:
 *   npm run eval -- v2                 # one version
 *   npm run eval -- v1 --only 02-ana   # a single persona, by id prefix
 *   npm run eval -- v2 --dry-run       # check fixtures and reachability only
 *
 * Environment (defaults in .env.example):
 *   EVAL_BASE_URL        where the app is           (default http://localhost:3000)
 *   EVAL_CONCURRENCY     personas in flight at once (default 4)
 *   PERSONA_MODEL / AGENT_MODEL / JUDGE_MODEL
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { complete } from "../src/lib/llm";
import {
  addRoleSpend,
  addSpend,
  addToRole,
  assertRatesKnown,
  conversationSpend,
  currentModels,
  emptyRoleSpend,
  emptySpend,
  formatTokens,
  formatUsd,
  ROLES,
  setModel,
  totalSpend,
  type Role,
  type RoleSpend,
  type TokenSpend,
} from "../src/lib/config";
import { MAX_TURNS, VERSIONS, type Version } from "../src/lib/agent";
import {
  type RunResult,
  type SuitabilityProfile,
  type Turn,
  type VersionResults,
} from "../src/lib/schema";
import { judgeRun } from "./judge";

// .env.local is what Next reads; mirror it here so both halves agree.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* absent is fine */
  }
}

const BASE_URL = (process.env.EVAL_BASE_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4);

// --- Fixtures ---------------------------------------------------------------

export interface GroundTruth {
  expected_outcome: "complete" | "insufficient_data";
  expected_stated_risk_tolerance: number | null;
  expected_behavioural_loss_tolerance: number | null;
  expected_capacity_for_loss: "low" | "medium" | "high" | null;
  expected_horizon_years: number | null;
  expected_risk_band: number | null;
  expected_knowledge_level: string | null;
  /** Pairs the agent MUST find. Scored for both precision and recall. */
  expected_contradictions: [string, string][];
  /** Defensible but not required. Neither rewarded nor penalised. */
  acceptable_contradictions: [string, string][];
  expected_boundary_test: boolean;
  /** Null means "not scored" — a defensible judgement call either way. */
  expected_vulnerability_flag: boolean | null;
  notes: string;
}

export interface Persona {
  id: string;
  name: string;
  adversarial: boolean;
  biography: string;
  facts: Record<string, unknown>;
  behaviour: string;
  ground_truth: GroundTruth;
}

const FIXTURE_DIR = join(process.cwd(), "fixtures", "personas");

export function loadPersonas(): Persona[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Persona);
}

// --- Persona simulator ------------------------------------------------------

function personaSystem(p: Persona): string {
  return `You are playing a client in a suitability intake conversation. Stay in character at all times. You are NOT an assistant and you never break character.

WHO YOU ARE
${p.name}. ${p.biography}

WHAT YOU KNOW ABOUT YOUR OWN SITUATION (reveal only when asked, except where your behaviour brief says to volunteer something)
${JSON.stringify(p.facts, null, 2)}

HOW YOU BEHAVE
${p.behaviour}

RULES
- Reply only as ${p.name}, in the first person. One short reply, two to four sentences.
- Never mention that you are playing a role, never refer to a brief or to instructions, and never describe your own behaviour from the outside.
- Never invent financial facts that are not in the list above. If asked something the list does not cover, give a vague, natural, non-committal answer rather than making up a number.
- Do not be more articulate or more self-aware than the character would be.`;
}

async function personaReply(
  p: Persona,
  transcript: Turn[],
): Promise<{ text: string; spend: TokenSpend }> {
  // Roles invert: the intake agent is the "user" the persona responds to.
  const messages = transcript.map((t) => ({
    role: t.role === "agent" ? ("user" as const) : ("assistant" as const),
    content: t.text,
  }));
  const result = await complete({
    role: "persona",
    label: `persona:${p.id}`,
    system: personaSystem(p),
    messages,
    maxTokens: 1000,
  });
  return { text: result.text, spend: result.spend };
}

// --- One conversation -------------------------------------------------------

interface IntakeResponse {
  version: string;
  /** The model that actually answered, echoed back by the route. */
  agent_model: string;
  turn: Turn;
  done: boolean;
  profile: SuitabilityProfile | null;
  error: string | null;
  invariant_problems: string[];
  /** Agent-role spend only — the route never calls the persona or the judge. */
  spend: TokenSpend;
}

class UnreachableError extends Error {}

async function postIntake(
  version: Version,
  transcript: Turn[],
  agentModel: string,
): Promise<IntakeResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, transcript, agent_model: agentModel }),
    });
  } catch {
    throw new UnreachableError(`cannot reach ${BASE_URL}`);
  }
  const body = (await res.json()) as Partial<IntakeResponse> & { error?: string };
  if (!res.ok) {
    // A 503 from the route is an infrastructure fault, not a score.
    throw new UnreachableError(body.error ?? `HTTP ${res.status}`);
  }
  return body as IntakeResponse;
}

interface Conversation {
  transcript: Turn[];
  profile: SuitabilityProfile | null;
  error: string | null;
  /** Reached a natural end, whether or not the extraction then validated. */
  completed: boolean;
  /** What the route said it ran, so results record fact rather than intent. */
  agent_model: string | null;
  spend: RoleSpend;
}

async function runPersona(
  version: Version,
  persona: Persona,
  agentModel: string,
): Promise<Conversation> {
  const transcript: Turn[] = [];
  let spend = emptyRoleSpend();
  let observed: string | null = null;

  for (let i = 0; i <= MAX_TURNS; i++) {
    const res = await postIntake(version, transcript, agentModel);
    spend = addToRole(spend, "agent", res.spend);
    observed = res.agent_model ?? observed;
    transcript.push({ ...res.turn, index: transcript.length });

    if (res.done) {
      return {
        transcript,
        profile: res.profile,
        error: res.error,
        completed: true,
        agent_model: observed,
        spend,
      };
    }

    const reply = await personaReply(persona, transcript);
    spend = addToRole(spend, "persona", reply.spend);
    transcript.push({
      role: "client",
      text: reply.text,
      index: transcript.length,
    });
  }

  // The conversation never closed itself. That is a harness-visible defect in
  // the agent, not a completed conversation with a bad profile, so it is
  // excluded from the per-conversation cost mean.
  return {
    transcript,
    profile: null,
    error: `conversation did not terminate within ${MAX_TURNS} turns`,
    completed: false,
    agent_model: observed,
    spend,
  };
}

// --- Orchestration ----------------------------------------------------------

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Ground-truth expectations that are excluded from a denominator when null.
 *
 * `expected_risk_band: null` is deliberately NOT here. Tomasz's null is a
 * scored expectation — the right answer is "no band", and producing one is the
 * failure. A field belongs on this list only when null means "either answer is
 * defensible, so do not score it".
 */
const UNSCORABLE_WHEN_NULL = ["expected_vulnerability_flag"] as const;

function unscorableFields(gt: GroundTruth): string[] {
  return UNSCORABLE_WHEN_NULL.filter((f) => gt[f] === null);
}

async function runVersion(
  version: Version,
  personas: Persona[],
  agentModel: string,
): Promise<{ results: VersionResults; observedAgentModels: Set<string> }> {
  const observedAgentModels = new Set<string>();

  const runs = await pool(personas, CONCURRENCY, async (persona) => {
    const gt = persona.ground_truth;
    const convo = await runPersona(version, persona, agentModel);
    if (convo.agent_model) observedAgentModels.add(convo.agent_model);

    const base = {
      persona_id: persona.id,
      persona_name: persona.name,
      adversarial: persona.adversarial,
      expected_risk_band: gt.expected_risk_band,
      expected_outcome: gt.expected_outcome,
      expected_vulnerability_flag: gt.expected_vulnerability_flag,
      transcript: convo.transcript,
      conversation_completed: convo.completed,
      unscorable_fields: unscorableFields(gt),
      tolerated_contradiction_pairs: gt.acceptable_contradictions.length,
      spend: convo.spend,
    };

    // No schema-valid profile => INVALID. Counted as its own finding, never
    // spread across the five criteria as if it were five quality failures.
    if (convo.profile === null || convo.error !== null) {
      const r: RunResult = {
        ...base,
        outcome: "invalid",
        invalid_reason: convo.error ?? "no profile produced",
        actual_risk_band: null,
        actual_outcome: null,
        actual_vulnerability_flag: null,
        proposed_risk_band: null,
        band_divergence: null,
        profile: convo.profile,
        criteria: [],
      };
      process.stdout.write(
        `  ${version} ${persona.id.padEnd(30)} INVALID${tokenNote(r.spend)}\n`,
      );
      return r;
    }

    const p = convo.profile;
    const judged = await judgeRun(persona, convo.transcript, p);

    const r: RunResult = {
      ...base,
      outcome: "scored",
      invalid_reason: null,
      actual_risk_band: p.risk_band,
      actual_outcome: p.outcome,
      actual_vulnerability_flag: p.vulnerability_flag,
      proposed_risk_band: p.proposed_risk_band,
      band_divergence: p.band_divergence,
      profile: p,
      criteria: judged.criteria,
      spend: addToRole(convo.spend, "judge", judged.spend),
    };
    const failed = r.criteria.filter((c) => !c.passed).length;
    process.stdout.write(
      `  ${version} ${persona.id.padEnd(30)} band ${String(p.risk_band ?? "-").padStart(2)}/${gt.expected_risk_band ?? "-"}  ${(failed === 0 ? "clean" : `${failed} fail`).padEnd(7)}${tokenNote(r.spend)}\n`,
    );
    return r;
  });

  return {
    results: {
      version,
      ran_at: new Date().toISOString(),
      // The agent model is what the route reported running, not what was
      // requested. The other two run in this process, so they are read
      // straight from config.
      models: {
        ...currentModels(),
        agent: [...observedAgentModels].join(" + ") || agentModel,
      },
      runs,
      spend: runs.reduce((a, r) => addRoleSpend(a, r.spend), emptyRoleSpend()),
    },
    observedAgentModels,
  };
}

/** Per-role tokens, per run: `agent 4.2k/0.9k · client 1.1k/0.3k · judge ...` */
function tokenNote(spend: RoleSpend): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const parts = ROLES.filter(
    (role) => spend[role].input_tokens + spend[role].output_tokens > 0,
  ).map(
    (role) =>
      `${role === "persona" ? "client" : role} ${k(spend[role].input_tokens)}/${k(spend[role].output_tokens)}`,
  );
  return parts.length === 0
    ? ""
    : `  ${parts.join(" · ")}  ${formatUsd(totalSpend(spend).cost_usd)}`;
}

// --- Entry point ------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const versions = args.filter((a): a is Version =>
    (VERSIONS as readonly string[]).includes(a),
  );
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const dryRun = args.includes("--dry-run");

  // Arm swapping. `--agent=claude-opus-5` overrides config for this run; the
  // agent model travels to the route in the request body, because the agent
  // runs behind HTTP and would otherwise keep whatever the server started with.
  for (const role of ROLES) {
    const flag = args.find((a) => a.startsWith(`--${role}=`));
    if (flag) setModel(role, flag.slice(`--${role}=`.length));
  }
  const models = currentModels();

  // Refuse before spending, not after reporting. A model with no rate would
  // produce a run whose cost is $0.00 for the wrong reason.
  try {
    assertRatesKnown(Object.values(models));
  } catch (err) {
    console.error(`FATAL: ${(err as Error).message}`);
    return 2;
  }

  const targets = versions.length > 0 ? versions : [...VERSIONS];
  let personas = loadPersonas();
  if (only) personas = personas.filter((p) => p.id.startsWith(only));

  if (personas.length === 0) {
    console.error(`No personas matched${only ? ` "${only}"` : ""}.`);
    return 2;
  }

  // Fail loudly and early if the app is not up.
  try {
    const probe = await fetch(`${BASE_URL}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: [], version: "nope" }),
    });
    if (probe.status !== 400) {
      console.error(
        `FATAL: ${BASE_URL}/api/intake answered ${probe.status}, expected 400 for a bad version.`,
      );
      console.error("Is something else running on that port?");
      return 2;
    }
  } catch {
    console.error(`FATAL: cannot reach the app at ${BASE_URL}.`);
    console.error("Start it with `npm run dev` first, then re-run.");
    return 2;
  }

  console.log(
    `\nsuitability-gate eval · ${BASE_URL} · ${personas.length} personas × ${targets.length} version(s)`,
  );
  console.log(
    `  agent ${models.agent} · judge ${models.judge} · client ${models.persona}\n`,
  );

  if (dryRun) {
    console.log("Dry run: fixtures load, rates are known, and the app is reachable. Nothing spent.\n");
    return 0;
  }

  mkdirSync(join(process.cwd(), "results"), { recursive: true });
  let total = emptyRoleSpend();

  for (const version of targets) {
    let ran: Awaited<ReturnType<typeof runVersion>>;
    try {
      ran = await runVersion(version, personas, models.agent);
    } catch (err) {
      if (err instanceof UnreachableError) {
        console.error(`\nFATAL: ${err.message} — aborting rather than scoring a partial run.`);
        return 2;
      }
      throw err;
    }
    const results = ran.results;

    // The route is the authority on which model answered. If it ran something
    // other than what was asked for, the results file would be describing a
    // model that was not under test.
    if (ran.observedAgentModels.size > 1) {
      console.error(
        `\nFATAL: the route answered with more than one agent model (${[...ran.observedAgentModels].join(", ")}).`,
      );
      return 2;
    }
    const observed = [...ran.observedAgentModels][0];
    if (observed && observed !== models.agent) {
      console.error(
        `\nFATAL: asked for agent ${models.agent}, the route ran ${observed}. Refusing to label these results.`,
      );
      return 2;
    }

    const out = join(process.cwd(), "results", `${version}.json`);
    writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
    total = addRoleSpend(total, results.spend);

    console.log(`\n  ${version}: ${results.runs.length} runs · ${out.replace(process.cwd() + "/", "")}`);
    console.log(costTable(results));
  }

  if (targets.length > 1) {
    console.log(`Total across versions: ${formatUsd(totalSpend(total).cost_usd)}\n`);
  }
  console.log("Open http://localhost:3000/gate to see the verdict.\n");
  return 0;
}

/**
 * Cost, per role, stated with its denominator.
 *
 * The per-conversation mean counts the AGENT only: the client simulator and
 * the judge are test apparatus, and neither exists when a real client is on
 * the other end. Reporting their cost as part of "what a conversation costs"
 * would be a number nobody could act on.
 */
function costTable(results: VersionResults): string {
  const completed = results.runs.filter((r) => r.conversation_completed);
  const agentCost = completed.reduce(
    (a, r) => a + conversationSpend(r.spend).cost_usd,
    0,
  );
  const total = totalSpend(results.spend);

  const rows = ROLES.map((role) => {
    const s = results.spend[role];
    const label = role === "persona" ? "client sim" : role;
    return `    ${label.padEnd(11)} ${formatTokens(s.input_tokens).padStart(9)} in  ${formatTokens(s.output_tokens).padStart(8)} out  ${formatUsd(s.cost_usd).padStart(9)}`;
  });

  const mean = completed.length === 0 ? 0 : agentCost / completed.length;
  return [
    ...rows,
    `    ${"total".padEnd(11)} ${formatTokens(total.input_tokens).padStart(9)} in  ${formatTokens(total.output_tokens).padStart(8)} out  ${formatUsd(total.cost_usd).padStart(9)}`,
    ``,
    `    mean per completed conversation (agent only): ${formatUsd(mean)}  over ${completed.length}/${results.runs.length}`,
    ``,
  ].join("\n");
}

if (process.argv[1]?.endsWith("run_eval.ts")) {
  main().then((code) => process.exit(code));
}
