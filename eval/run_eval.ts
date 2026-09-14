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
import { complete, addSpend, emptySpend, formatUsd, MODELS } from "../src/lib/llm";
import { MAX_TURNS, VERSIONS, type Version } from "../src/lib/agent";
import {
  computeRiskBand,
  type RunResult,
  type SuitabilityProfile,
  type TokenSpend,
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
    tier: "persona",
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
  turn: Turn;
  done: boolean;
  profile: SuitabilityProfile | null;
  error: string | null;
  invariant_problems: string[];
  spend: TokenSpend;
}

class UnreachableError extends Error {}

async function postIntake(
  version: Version,
  transcript: Turn[],
): Promise<IntakeResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, transcript }),
    });
  } catch (cause) {
    throw new UnreachableError(`cannot reach ${BASE_URL}`);
  }
  const body = (await res.json()) as Partial<IntakeResponse> & { error?: string };
  if (!res.ok) {
    // A 503 from the route is an infrastructure fault, not a score.
    throw new UnreachableError(body.error ?? `HTTP ${res.status}`);
  }
  return body as IntakeResponse;
}

async function runPersona(
  version: Version,
  persona: Persona,
): Promise<{ transcript: Turn[]; profile: SuitabilityProfile | null; error: string | null; spend: TokenSpend }> {
  const transcript: Turn[] = [];
  let spend = emptySpend();

  for (let i = 0; i <= MAX_TURNS; i++) {
    const res = await postIntake(version, transcript);
    spend = addSpend(spend, res.spend);
    transcript.push({ ...res.turn, index: transcript.length });

    if (res.done) {
      return { transcript, profile: res.profile, error: res.error, spend };
    }

    const reply = await personaReply(persona, transcript);
    spend = addSpend(spend, reply.spend);
    transcript.push({
      role: "client",
      text: reply.text,
      index: transcript.length,
    });
  }

  return {
    transcript,
    profile: null,
    error: `conversation did not terminate within ${MAX_TURNS} turns`,
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

async function runVersion(
  version: Version,
  personas: Persona[],
): Promise<VersionResults> {
  const runs = await pool(personas, CONCURRENCY, async (persona) => {
    const gt = persona.ground_truth;
    let convo;
    try {
      convo = await runPersona(version, persona);
    } catch (err) {
      if (err instanceof UnreachableError) throw err;
      throw err;
    }

    const base = {
      persona_id: persona.id,
      persona_name: persona.name,
      adversarial: persona.adversarial,
      expected_risk_band: gt.expected_risk_band,
      expected_outcome: gt.expected_outcome,
      expected_vulnerability_flag: gt.expected_vulnerability_flag,
      transcript: convo.transcript,
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
      process.stdout.write(`  ${version} ${persona.id.padEnd(30)} INVALID\n`);
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
      spend: addSpend(convo.spend, judged.spend),
    };
    const failed = r.criteria.filter((c) => !c.passed).length;
    process.stdout.write(
      `  ${version} ${persona.id.padEnd(30)} band ${String(p.risk_band ?? "-").padStart(2)}/${gt.expected_risk_band ?? "-"}  ${failed === 0 ? "clean" : `${failed} fail`}\n`,
    );
    return r;
  });

  return {
    version,
    ran_at: new Date().toISOString(),
    models: { agent: MODELS.agent, persona: MODELS.persona, judge: MODELS.judge },
    runs,
    spend: runs.reduce((a, r) => addSpend(a, r.spend), emptySpend()),
  };
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
    `  agent ${MODELS.agent} · persona ${MODELS.persona} · judge ${MODELS.judge}\n`,
  );

  if (dryRun) {
    console.log("Dry run: fixtures load and the app is reachable. Nothing spent.\n");
    return 0;
  }

  mkdirSync(join(process.cwd(), "results"), { recursive: true });
  let total = emptySpend();

  for (const version of targets) {
    let results: VersionResults;
    try {
      results = await runVersion(version, personas);
    } catch (err) {
      if (err instanceof UnreachableError) {
        console.error(`\nFATAL: ${err.message} — aborting rather than scoring a partial run.`);
        return 2;
      }
      throw err;
    }

    const out = join(process.cwd(), "results", `${version}.json`);
    writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
    total = addSpend(total, results.spend);
    console.log(
      `\n  ${version}: ${results.runs.length} runs · ${formatUsd(results.spend.cost_usd)} · ${out.replace(process.cwd() + "/", "")}\n`,
    );
  }

  console.log(
    `Total spend: ${formatUsd(total.cost_usd)}  (${total.input_tokens.toLocaleString()} in / ${total.output_tokens.toLocaleString()} out)\n`,
  );
  console.log("Open http://localhost:3000/gate to see the verdict.\n");
  return 0;
}

if (process.argv[1]?.endsWith("run_eval.ts")) {
  main().then((code) => process.exit(code));
}
