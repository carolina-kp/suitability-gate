#!/usr/bin/env tsx
/**
 * The run configuration and the money, tested.
 *
 * Cost is now a headline number on the verdict screen, which makes the rates
 * table and the per-role split things that can be quietly wrong in a way
 * nobody notices — the failure mode being a number that looks plausible.
 * These cases pin the arithmetic, the denominators, and the two facts about
 * the model split that are load-bearing rather than decorative.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addToRole,
  assertRatesKnown,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  conversationSpend,
  DEFAULT_MODELS,
  emptyRoleSpend,
  emptySpend,
  modelFor,
  RATES,
  rateFor,
  ROLES,
  spendOf,
  totalSpend,
  unpricedModels,
  type Role,
} from "../src/lib/config";
import {
  scoreVersion,
  type CriterionId,
  type RunResult,
  type VersionResults,
} from "../src/lib/schema";
import { loadPersonas } from "./run_eval";

// --- The model split --------------------------------------------------------

test("the judge is never the agent's own model", () => {
  // Not a style preference: a model grading its own output carries a
  // self-preference bias, and the whole scorecard inherits it.
  assert.notEqual(
    DEFAULT_MODELS.judge,
    DEFAULT_MODELS.agent,
    "agent and judge share a model — every model-graded criterion is now suspect",
  );
});

test("the arm under test is the one a bank would deploy", () => {
  assert.equal(DEFAULT_MODELS.agent, "claude-haiku-4-5");
  assert.equal(DEFAULT_MODELS.judge, "claude-sonnet-5");
  assert.equal(DEFAULT_MODELS.persona, "claude-haiku-4-5");
});

test("a model is a config value, not a constant", () => {
  const before = process.env.AGENT_MODEL;
  try {
    process.env.AGENT_MODEL = "claude-opus-5";
    assert.equal(modelFor("agent"), "claude-opus-5");
    // Read at call time, so a CLI flag set after import still takes effect.
    process.env.AGENT_MODEL = "";
    assert.equal(modelFor("agent"), DEFAULT_MODELS.agent);
  } finally {
    if (before === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = before;
  }
});

// --- Rates ------------------------------------------------------------------

test("every model in the default arm has a rate", () => {
  assert.deepEqual(unpricedModels(Object.values(DEFAULT_MODELS)), []);
});

test("the rates table matches the published per-million prices", () => {
  assert.deepEqual(RATES["claude-opus-5"], { input: 5, output: 25 });
  assert.deepEqual(RATES["claude-sonnet-5"], { input: 2, output: 10 });
  assert.deepEqual(RATES["claude-haiku-4-5"], { input: 1, output: 5 });
});

test("an unpriced model refuses to start rather than reporting $0.00", () => {
  assert.equal(rateFor("claude-not-a-model"), null);
  assert.throws(
    () => assertRatesKnown(["claude-haiku-4-5", "claude-not-a-model"]),
    /claude-not-a-model/,
  );
});

test("cost is tokens times the rate, with the cache multipliers applied", () => {
  const spend = spendOf("claude-sonnet-5", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  const expected =
    2 + 10 + 2 * CACHE_READ_MULTIPLIER + 2 * CACHE_WRITE_MULTIPLIER;
  assert.equal(spend.cost_usd, expected);
  assert.equal(spend.unpriced_tokens, 0);
});

test("tokens from an unpriced model are counted, not silently costed at zero", () => {
  const spend = spendOf("claude-not-a-model", {
    input_tokens: 100,
    output_tokens: 50,
  });
  assert.equal(spend.cost_usd, 0);
  // The screen turns this red rather than reporting a cheap-looking run.
  assert.equal(spend.unpriced_tokens, 150);
});

// --- Spend, per role --------------------------------------------------------

test("spend is attributed to the role that spent it", () => {
  let rs = emptyRoleSpend();
  rs = addToRole(rs, "agent", spendOf("claude-haiku-4-5", { input_tokens: 1000, output_tokens: 1000 }));
  rs = addToRole(rs, "persona", spendOf("claude-haiku-4-5", { input_tokens: 1000, output_tokens: 1000 }));
  rs = addToRole(rs, "judge", spendOf("claude-sonnet-5", { input_tokens: 1000, output_tokens: 1000 }));

  // 1000 in + 1000 out: haiku 0.001 + 0.005, sonnet 0.002 + 0.010.
  assert.equal(Number(rs.agent.cost_usd.toFixed(6)), 0.006);
  assert.equal(Number(rs.judge.cost_usd.toFixed(6)), 0.012);
  assert.equal(Number(totalSpend(rs).cost_usd.toFixed(6)), 0.024);
  assert.equal(totalSpend(rs).input_tokens, 3000);

  // A conversation costs what the agent cost. The simulator and the judge are
  // the test rig and would not exist with a real client on the other end.
  assert.equal(conversationSpend(rs), rs.agent);
});

test("every role is accounted for in the total", () => {
  const rs = ROLES.reduce(
    (acc, role: Role) =>
      addToRole(acc, role, spendOf("claude-haiku-4-5", { input_tokens: 100 })),
    emptyRoleSpend(),
  );
  assert.equal(totalSpend(rs).input_tokens, 100 * ROLES.length);
});

// --- The scorecard's denominators -------------------------------------------

const CLEAN: CriterionId[] = [
  "risk_band",
  "contradictions",
  "no_recommendation",
  "no_fabrication",
  "evidence_complete",
];

function run(over: Partial<RunResult>): RunResult {
  return {
    persona_id: "test",
    persona_name: "Test",
    adversarial: false,
    outcome: "scored",
    invalid_reason: null,
    expected_risk_band: 3,
    expected_outcome: "complete",
    expected_vulnerability_flag: false,
    actual_risk_band: 3,
    actual_outcome: "complete",
    actual_vulnerability_flag: false,
    proposed_risk_band: 3,
    band_divergence: 0,
    profile: null,
    transcript: [],
    criteria: CLEAN.map((id) => ({
      id,
      passed: true,
      reason: "",
      failing_turn_index: null,
      detail: (id === "risk_band"
        ? { exact: true, within_one: true }
        : {}) as Record<string, string | number | boolean>,
    })),
    conversation_completed: true,
    unscorable_fields: [],
    tolerated_contradiction_pairs: 0,
    spend: emptyRoleSpend(),
    ...over,
  };
}

function version(runs: RunResult[]): VersionResults {
  return {
    version: "v1",
    ran_at: "2026-01-01T00:00:00.000Z",
    models: { ...DEFAULT_MODELS },
    runs,
    spend: runs.reduce(
      (acc, r) =>
        ROLES.reduce((a, role) => addToRole(a, role, r.spend[role]), acc),
      emptyRoleSpend(),
    ),
  };
}

const withSpend = (agent: number, persona: number, judge: number) => ({
  ...emptyRoleSpend(),
  agent: { ...emptySpend(), cost_usd: agent },
  persona: { ...emptySpend(), cost_usd: persona },
  judge: { ...emptySpend(), cost_usd: judge },
});

test("cost per conversation counts the agent, over conversations that happened", () => {
  const card = scoreVersion(
    version([
      run({ persona_id: "a", spend: withSpend(0.02, 0.01, 0.05) }),
      run({ persona_id: "b", spend: withSpend(0.04, 0.01, 0.05) }),
      // Never terminated: excluded from the mean, included in the total.
      run({
        persona_id: "c",
        outcome: "invalid",
        invalid_reason: "did not terminate",
        criteria: [],
        conversation_completed: false,
        spend: withSpend(0.09, 0.03, 0),
      }),
    ]),
  );

  assert.equal(card.completed_conversations, 2);
  assert.equal(Number(card.mean_cost_per_conversation.toFixed(4)), 0.03);
  // Including the client simulator: (0.03 + 0.05) / 2.
  assert.equal(Number(card.mean_harness_cost_per_conversation.toFixed(4)), 0.04);
  // The total holds everything, including the run that never finished.
  assert.equal(Number(card.cost_total.toFixed(4)), 0.3);
});

test("null expectations are counted, not just quietly dropped", () => {
  const card = scoreVersion(
    version([
      run({ persona_id: "a" }),
      run({
        persona_id: "b",
        expected_vulnerability_flag: null,
        actual_vulnerability_flag: true,
        unscorable_fields: ["expected_vulnerability_flag"],
        tolerated_contradiction_pairs: 3,
      }),
    ]),
  );

  // Excluded from the denominator...
  assert.equal(card.vulnerability_scored, 1);
  assert.equal(card.vulnerability_rate, 1);
  // ...and visible as its own number, next to the rate it shrank.
  assert.equal(card.unscorable_total, 1);
  assert.deepEqual(card.unscorable_by_field, {
    expected_vulnerability_flag: ["b"],
  });
  assert.equal(card.tolerated_pairs_total, 3);
});

test("a clean sheet has nothing sitting outside a denominator", () => {
  const card = scoreVersion(version([run({}), run({ persona_id: "b" })]));
  assert.equal(card.unscorable_total, 0);
  assert.equal(card.tolerated_pairs_total, 0);
  assert.equal(card.unpriced_tokens, 0);
});

// --- The fixtures, as the screen will count them ----------------------------

test("the fixture set's unscorable expectations are the ones we think", () => {
  const personas = loadPersonas();
  const nullVuln = personas.filter(
    (p) => p.ground_truth.expected_vulnerability_flag === null,
  );
  assert.deepEqual(
    nullVuln.map((p) => p.id),
    ["03-ilona-reaching-for-yield"],
    "the set of deliberately-unscored cases changed — say so on the screen, not in a commit message",
  );

  // Tomasz's null band is NOT unscorable: the right answer is "no band", and
  // producing one is the failure. It stays in the denominator.
  const nullBand = personas.filter(
    (p) => p.ground_truth.expected_risk_band === null,
  );
  assert.deepEqual(nullBand.map((p) => p.id), ["04-tomasz-refuses"]);
});

test("acceptable contradiction pairs are a stated quantity", () => {
  const personas = loadPersonas();
  const tolerated = personas.reduce(
    (a, p) => a + p.ground_truth.acceptable_contradictions.length,
    0,
  );
  const required = personas.reduce(
    (a, p) => a + p.ground_truth.expected_contradictions.length,
    0,
  );
  assert.equal(required, 5);
  assert.equal(tolerated, 11);
});
