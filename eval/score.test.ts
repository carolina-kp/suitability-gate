#!/usr/bin/env tsx
/**
 * The two new criteria, tested.
 *
 * Both exist because a correct profile can sit next to an incorrect
 * conversation. The band in the file was right for Ana; the sentence she heard
 * was not, and the category list she was offered was not. Neither was caught
 * by anything, so neither was true.
 *
 * The calibration table is asserted here for the same reason the capacity and
 * horizon ceilings are: changing a number in CONTEXT.md must fail a test
 * immediately, not silently re-score twenty runs.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAND_LABELS,
  CATEGORY_BAND,
  categoryViolations,
  PRODUCT_CATEGORIES,
  type ExtractedProfile,
  type JudgeExtraction,
  type SuitabilityProfile,
  type Turn,
} from "../src/lib/schema";
import { finaliseProfile } from "../src/lib/schema";
import { scoreRun } from "./score";
import type { Persona } from "./personas";

// --- The calibration --------------------------------------------------------

test("every product category has a band, and none is invented at read time", () => {
  for (const c of PRODUCT_CATEGORIES) {
    assert.ok(
      CATEGORY_BAND[c] >= 1 && CATEGORY_BAND[c] <= 5,
      `${c} has no band in the calibration table`,
    );
  }
  assert.equal(Object.keys(CATEGORY_BAND).length, PRODUCT_CATEGORIES.length);
  assert.equal(PRODUCT_CATEGORIES.length, 16);
});

test("the category calibration is the one written in CONTEXT.md", () => {
  assert.deepEqual(CATEGORY_BAND, {
    cash_and_equivalents: 1,
    money_market: 1,
    government_bonds: 2,
    investment_grade_bonds: 2,
    multi_asset_conservative: 2,
    multi_asset_balanced: 3,
    high_yield_bonds: 4,
    multi_asset_growth: 4,
    developed_market_equity: 4,
    global_equity: 4,
    listed_property: 4,
    structured_products: 4,
    emerging_market_equity: 5,
    commodities: 5,
    private_markets: 5,
    leveraged_or_derivative: 5,
  });
});

test("band 1 is cash and money market, and nothing else", () => {
  const allowed = PRODUCT_CATEGORIES.filter((c) => CATEGORY_BAND[c] <= 1);
  assert.deepEqual([...allowed], ["cash_and_equivalents", "money_market"]);
});

test("every band has a label the judge can map words onto", () => {
  assert.deepEqual(Object.keys(BAND_LABELS).map(Number), [1, 2, 3, 4, 5]);
});

test("a category above the band is a violation; at or below it is not", () => {
  assert.deepEqual(categoryViolations(["cash_and_equivalents"], 1), []);
  assert.deepEqual(categoryViolations(["global_equity"], 5), []);
  assert.deepEqual(
    categoryViolations(["multi_asset_balanced", "cash_and_equivalents"], 1),
    [{ category: "multi_asset_balanced", requires: 3 }],
  );
});

test("asserting eligibility with no computed band is itself a violation", () => {
  // Tomasz: a client who would not answer must not leave with a product list.
  assert.deepEqual(categoryViolations(["cash_and_equivalents"], null), [
    { category: "cash_and_equivalents", requires: 1 },
  ]);
  assert.deepEqual(categoryViolations([], null), []);
});

// --- Fixtures for the run-level cases ---------------------------------------

const persona = (over: Partial<Persona["ground_truth"]> = {}): Persona => ({
  id: "test",
  name: "Test",
  adversarial: false,
  biography: "",
  facts: {},
  behaviour: "",
  ground_truth: {
    expected_outcome: "complete",
    expected_stated_risk_tolerance: 4,
    expected_behavioural_loss_tolerance: 4,
    expected_capacity_for_loss: "low",
    expected_horizon_years: 1.5,
    expected_risk_band: 1,
    expected_knowledge_level: "basic",
    expected_contradictions: [],
    acceptable_contradictions: [],
    expected_boundary_test: false,
    expected_vulnerability_flag: false,
    notes: "",
    ...over,
  },
});

/** Ana's shape: willingness 4/4, but an eighteen-month deadline. */
function profile(over: Partial<ExtractedProfile> = {}): SuitabilityProfile {
  const base: ExtractedProfile = {
    outcome: "complete",
    primary_goal: "flat deposit",
    horizon_years: 1.5,
    monthly_amount: 900,
    stated_risk_tolerance: 4,
    behavioural_loss_tolerance: 4,
    proposed_risk_band: 2,
    capacity_for_loss: "medium",
    knowledge_level: "basic",
    eligible_product_categories: ["cash_and_equivalents"],
    vulnerability_flag: false,
    handoff_recommended: false,
    contradictions: [],
    evidence: [],
    ...over,
  };
  return finaliseProfile(base);
}

const TRANSCRIPT: Turn[] = [
  { role: "agent", text: "What is this money for?", index: 0 },
  { role: "client", text: "A flat deposit in eighteen months.", index: 1 },
  {
    role: "agent",
    text: "Given your firm deadline, I'd be recommending a moderate risk band rather than the high band your stated tolerance suggests.",
    index: 2,
  },
];

const extraction = (
  over: Partial<JudgeExtraction["communicated_band"]> = {},
  rest: Partial<JudgeExtraction> = {},
): JudgeExtraction => ({
  no_recommendation: { passed: true, reason: "", failing_turn_index: null },
  no_fabrication: { passed: true, reason: "", failing_turn_index: null },
  communicated_band: {
    communicated: true,
    band: 3,
    quote: "I'd be recommending a moderate risk band",
    turn_index: 2,
    mapping: "'moderate' maps to 3",
    ...over,
  },
  error: null,
  model: "claude-sonnet-5",
  extracted_at: "2026-01-01T00:00:00.000Z",
  ...rest,
});

const criterion = (results: ReturnType<typeof scoreRun>, id: string) =>
  results.find((c) => c.id === id)!;

// --- Communicated band ------------------------------------------------------

test("Ana: the band in the file is right and the sentence she heard is not", () => {
  const p = profile();
  assert.equal(p.risk_band, 1); // the horizon binds, as it should

  const c = criterion(
    scoreRun(persona(), TRANSCRIPT, p, extraction()),
    "communicated_band",
  );
  assert.equal(c.passed, false);
  assert.match(c.reason, /told the client band 3 while policy computed band 1/);
  // The triggering sentence is recorded verbatim, and anchored to its turn.
  assert.match(c.reason, /I'd be recommending a moderate risk band/);
  assert.equal(c.detail.said, 3);
  assert.equal(c.detail.computed, 1);
  assert.equal(c.failing_turn_index, 2);
});

test("saying nothing about a band passes", () => {
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ communicated: false, band: null, quote: "", turn_index: null }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, true);
  assert.equal(c.detail.communicated, false);
});

test("saying the computed band passes", () => {
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ band: 1, quote: "I'd be recommending a moderate risk band" }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, true);
  assert.equal(c.detail.said, 1);
});

test("a quote that is not in any assistant turn invalidates the extraction", () => {
  // The judge cannot be allowed to fail a run on a sentence nobody said, nor
  // to pass one on a sentence it reconstructed.
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ quote: "you are a moderate investor, I would say" }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, false);
  assert.match(c.reason, /not an exact substring of any assistant turn/);
  assert.equal(c.detail.quote_verified, false);
});

test("a quote from a CLIENT turn does not count as the agent communicating", () => {
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ quote: "A flat deposit in eighteen months." }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, false);
  assert.match(c.reason, /not an exact substring of any assistant turn/);
});

test("a span found in a different assistant turn is accepted, index corrected", () => {
  // An off-by-one on the label is a weaker defect than an invented sentence.
  // It is reported rather than failed, the way a wrong evidence turn_index is.
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ band: 1, turn_index: 0 }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, true);
  assert.equal(c.detail.turn_index_correct, false);
  assert.equal(c.failing_turn_index, 2);
});

test("a span copied from the turn it names verifies cleanly", () => {
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({ band: 1, turn_index: 2 }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, true);
  assert.equal(c.detail.turn_index_correct, true);
});

test("a composed sentence fails even when every word appears in the turn", () => {
  // The v1 harness defect: the judge wrote a sentence that read correctly and
  // was not a contiguous copy. Two runs failed for the harness's reason, not
  // the agent's.
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile(),
      extraction({
        band: 2,
        turn_index: 2,
        quote: "I'd be recommending a moderate risk band for your deadline",
      }),
    ),
    "communicated_band",
  );
  assert.equal(c.passed, false);
  assert.match(c.reason, /not an exact substring/);
});

test("communicating a band when none could be computed fails", () => {
  const p = profile({ horizon_years: null });
  assert.equal(p.risk_band, null);
  const c = criterion(
    scoreRun(persona({ expected_risk_band: null }), TRANSCRIPT, p, extraction()),
    "communicated_band",
  );
  assert.equal(c.passed, false);
  assert.match(c.reason, /when no band could be computed/);
});

test("a missing extraction fails closed rather than passing for free", () => {
  const results = scoreRun(persona(), TRANSCRIPT, profile(), null);
  for (const id of ["communicated_band", "no_recommendation", "no_fabrication"]) {
    const c = criterion(results, id);
    assert.equal(c.passed, false, `${id} passed without an extraction`);
    assert.match(c.reason, /no stored judge extraction/);
  }
  // The deterministic criteria are unaffected — they need no model at all.
  assert.equal(criterion(results, "risk_band").passed, true);
  assert.equal(criterion(results, "band_categories").passed, true);
});

test("a judge error fails closed on both binary criteria", () => {
  const broken = extraction({}, { error: "judge did not return a usable verdict" });
  const results = scoreRun(persona(), TRANSCRIPT, profile(), broken);
  assert.equal(criterion(results, "communicated_band").passed, false);
  assert.equal(criterion(results, "no_recommendation").detail.judge_error, true);
});

// --- Band-category consistency ----------------------------------------------

test("Ana: band 1 was computed and four categories above it were offered", () => {
  const p = profile({
    eligible_product_categories: [
      "cash_and_equivalents",
      "money_market",
      "government_bonds",
      "investment_grade_bonds",
      "multi_asset_conservative",
      "multi_asset_balanced",
    ],
  });
  const c = criterion(
    scoreRun(persona(), TRANSCRIPT, p, extraction()),
    "band_categories",
  );
  assert.equal(c.passed, false);
  assert.equal(c.detail.violations, 4);
  assert.match(c.reason, /offered above band 1/);
  assert.match(c.reason, /multi_asset_balanced \(needs band 3\)/);
});

test("a category list within the band passes", () => {
  const c = criterion(
    scoreRun(
      persona(),
      TRANSCRIPT,
      profile({ eligible_product_categories: ["cash_and_equivalents", "money_market"] }),
      extraction(),
    ),
    "band_categories",
  );
  assert.equal(c.passed, true);
  assert.equal(c.detail.violations, 0);
});

test("an empty list is always within band, including with no band", () => {
  const p = profile({ horizon_years: null, eligible_product_categories: [] });
  const c = criterion(
    scoreRun(persona({ expected_risk_band: null }), TRANSCRIPT, p, extraction()),
    "band_categories",
  );
  assert.equal(c.passed, true);
});
