/**
 * The suitability policy, tested.
 *
 * "A policy you cannot unit-test is not a policy." These cases are the reason
 * the band computation lives in code rather than in a system prompt: the rule
 * is checkable without spending a token, and a change to the calibration in
 * CONTEXT.md fails here immediately rather than silently shifting twenty runs.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPACITY_CAP,
  computeRiskBand,
  deriveConfidence,
  finaliseProfile,
  horizonCap,
  type ExtractedProfile,
} from "../src/lib/schema";

test("capacity is a ceiling, per the CONTEXT.md calibration", () => {
  assert.equal(CAPACITY_CAP.low, 2);
  assert.equal(CAPACITY_CAP.medium, 4);
  assert.equal(CAPACITY_CAP.high, 5);
});

test("horizon ceiling brackets", () => {
  assert.equal(horizonCap(0), 1);
  assert.equal(horizonCap(1.5), 1);
  assert.equal(horizonCap(2), 2);
  assert.equal(horizonCap(4), 2);
  assert.equal(horizonCap(5), 3);
  assert.equal(horizonCap(9), 3);
  assert.equal(horizonCap(10), 5);
  assert.equal(horizonCap(30), 5);
});

test("persona 1 (Marek): behavioural answer overrides stated bravado", () => {
  const r = computeRiskBand({
    stated_risk_tolerance: 5,
    behavioural_loss_tolerance: 2,
    capacity_for_loss: "medium",
    horizon_years: 10,
  });
  assert.equal(r.band, 2);
  assert.deepEqual(r.binding, ["behavioural_loss_tolerance"]);
});

test("persona 2 (Ana): the case min(stated, behavioural) gets wrong", () => {
  const input = {
    stated_risk_tolerance: 4 as const,
    behavioural_loss_tolerance: 4 as const,
    capacity_for_loss: "low" as const,
    horizon_years: 1.5,
  };
  // Willingness alone would put her in band 4. She would genuinely hold
  // through a drawdown — temperament is not the problem. The deposit date is.
  assert.equal(
    Math.min(input.stated_risk_tolerance, input.behavioural_loss_tolerance),
    4,
  );
  const r = computeRiskBand(input);
  assert.equal(r.band, 1);
  assert.deepEqual(r.binding, ["horizon_cap"]);
});

test("persona 3 (Ilona): short horizon and low capacity both bind", () => {
  const r = computeRiskBand({
    stated_risk_tolerance: 4,
    behavioural_loss_tolerance: 4,
    capacity_for_loss: "low",
    horizon_years: 3,
  });
  assert.equal(r.band, 2);
  assert.deepEqual(r.binding.sort(), ["capacity_cap", "horizon_cap"]);
});

test("persona 6 (Dragan): no resilience and money needed soon", () => {
  const r = computeRiskBand({
    stated_risk_tolerance: 4,
    behavioural_loss_tolerance: 3,
    capacity_for_loss: "low",
    horizon_years: 1,
  });
  assert.equal(r.band, 1);
});

test("a missing input yields no band — not band 1", () => {
  const r = computeRiskBand({
    stated_risk_tolerance: 3,
    behavioural_loss_tolerance: null,
    capacity_for_loss: null,
    horizon_years: 10,
  });
  assert.equal(r.band, null);
  assert.deepEqual(r.missing.sort(), [
    "behavioural_loss_tolerance",
    "capacity_cap",
  ]);
});

test("every ceiling is reported, not just the binding one", () => {
  const r = computeRiskBand({
    stated_risk_tolerance: 5,
    behavioural_loss_tolerance: 4,
    capacity_for_loss: "high",
    horizon_years: 3,
  });
  assert.deepEqual(r.caps, {
    stated_risk_tolerance: 5,
    behavioural_loss_tolerance: 4,
    capacity_cap: 5,
    horizon_cap: 2,
  });
  assert.equal(r.band, 2);
});

// --- derived confidence -----------------------------------------------------

function profile(over: Partial<ExtractedProfile> = {}): ExtractedProfile {
  return {
    outcome: "complete",
    primary_goal: "deposit",
    horizon_years: 10,
    monthly_amount: 200,
    stated_risk_tolerance: 3,
    behavioural_loss_tolerance: 3,
    proposed_risk_band: 3,
    capacity_for_loss: "high",
    knowledge_level: "basic",
    eligible_product_categories: ["global_equity"],
    vulnerability_flag: false,
    handoff_recommended: false,
    contradictions: [],
    evidence: [
      "primary_goal",
      "horizon_years",
      "monthly_amount",
      "stated_risk_tolerance",
      "behavioural_loss_tolerance",
      "capacity_for_loss",
      "knowledge_level",
    ].map((field, i) => ({ field, quote: "q", turn_index: i } as never)),
    ...over,
  };
}

test("confidence is 1 only when everything is established and evidenced", () => {
  assert.equal(deriveConfidence(profile(), 3), 1);
});

test("confidence falls when the model disagrees with policy", () => {
  const p = profile({ proposed_risk_band: 5 });
  assert.equal(deriveConfidence(p, 3), 0.85);
});

test("confidence falls with an unresolved contradiction", () => {
  const p = profile({
    contradictions: [
      {
        field_a: "knowledge_level",
        field_b: "demonstrated_knowledge",
        description: "claims experienced, thinks ETFs are capital protected",
        resolution: "",
      },
    ],
  });
  assert.equal(deriveConfidence(p, 3), 0.9);
});

test("a half-answered intake cannot report high confidence", () => {
  const p = profile({
    outcome: "insufficient_data",
    monthly_amount: null,
    capacity_for_loss: null,
    knowledge_level: null,
    evidence: profile().evidence.slice(0, 4),
  });
  assert.ok(deriveConfidence(p, null) < 0.6);
});

test("finaliseProfile records divergence without overwriting the proposal", () => {
  const f = finaliseProfile(
    profile({ proposed_risk_band: 4, capacity_for_loss: "low" }),
  );
  assert.equal(f.proposed_risk_band, 4);
  assert.equal(f.risk_band, 2);
  assert.equal(f.band_divergence, 2);
  assert.deepEqual(f.binding, ["capacity_cap"]);
});

// --- Fixture consistency ----------------------------------------------------
//
// Ground truth is hand-written, so it can disagree with the policy it is
// supposed to encode. If it does, every band number on the /gate screen is
// measuring the fixture author's arithmetic rather than the agent.

import { loadPersonas } from "./personas";
import { CONTRADICTION_FIELDS, EVIDENCE_FIELDS } from "../src/lib/schema";

test("there are twenty personas, six of them adversarial", () => {
  const personas = loadPersonas();
  assert.equal(personas.length, 20);
  assert.equal(personas.filter((p) => p.adversarial).length, 6);
});

test("every persona's expected band follows from its own ground-truth inputs", () => {
  for (const p of loadPersonas()) {
    const gt = p.ground_truth;
    const computed = computeRiskBand({
      stated_risk_tolerance: gt.expected_stated_risk_tolerance as never,
      behavioural_loss_tolerance: gt.expected_behavioural_loss_tolerance as never,
      capacity_for_loss: gt.expected_capacity_for_loss,
      horizon_years: gt.expected_horizon_years,
    });
    assert.equal(
      computed.band,
      gt.expected_risk_band,
      `${p.id}: ground truth says band ${gt.expected_risk_band}, policy computes ${computed.band}`,
    );
  }
});

test("every persona's contradiction pairs use the closed vocabulary", () => {
  for (const p of loadPersonas()) {
    const pairs = [
      ...p.ground_truth.expected_contradictions,
      ...p.ground_truth.acceptable_contradictions,
    ];
    for (const [a, b] of pairs) {
      assert.ok(
        (CONTRADICTION_FIELDS as readonly string[]).includes(a),
        `${p.id}: "${a}" is not a contradiction field`,
      );
      assert.ok(
        (CONTRADICTION_FIELDS as readonly string[]).includes(b),
        `${p.id}: "${b}" is not a contradiction field`,
      );
      assert.notEqual(a, b, `${p.id}: contradiction pairs both sides identical`);
    }
  }
});

test("an insufficient-data persona expects no band at all", () => {
  const tomasz = loadPersonas().find((p) => p.id.startsWith("04-"))!;
  assert.equal(tomasz.ground_truth.expected_outcome, "insufficient_data");
  assert.equal(tomasz.ground_truth.expected_risk_band, null);
  assert.equal(tomasz.ground_truth.expected_boundary_test, true);
});

test("the set exercises every band and both boundary-test values", () => {
  const bands = new Set(
    loadPersonas().map((p) => p.ground_truth.expected_risk_band),
  );
  for (const b of [1, 2, 3, 4, 5, null]) {
    assert.ok(bands.has(b as never), `no persona expects band ${b}`);
  }
  const boundary = loadPersonas().filter(
    (p) => p.ground_truth.expected_boundary_test,
  );
  assert.equal(boundary.length, 2, "expected exactly two boundary-test personas");
  assert.equal(EVIDENCE_FIELDS.length, 7);
});
