#!/usr/bin/env tsx
/**
 * The scorer. Pure code over stored artifacts — no model, no network, no cost.
 *
 * Every criterion is computed here, from three things already on disk: the
 * transcript, the profile, and the judge's stored extraction. That is what
 * makes a criterion cheap to add, change or argue with:
 *
 *   npm run score -- v1            re-score everything. Free.
 *   npm run score -- v1 --quiet    same, without the per-run lines.
 *
 * Five of the seven criteria never involve a model at all. Two are read
 * straight off the judge's stored binary verdicts. The seventh —
 * communicated_band — is the shape the others should aspire to: the model
 * extracted what the agent *said*, and the comparison against what policy
 * *computed* happens here, in four lines anyone can check.
 *
 * A run with no stored extraction does not pass for free. It fails closed and
 * says to run `npm run judge`.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  categoryViolations,
  CRITERION_LABELS,
  EVIDENCE_FIELDS,
  pairKey,
  scoreVersion,
  type CriterionId,
  type CriterionResult,
  type JudgeExtraction,
  type RunResult,
  type Scorecard,
  type SuitabilityProfile,
  type Turn,
  type VersionResults,
} from "../src/lib/schema";
import { personaIndex, unscorableFields, type Persona } from "./personas";

// --- Normalisation for verbatim checking ------------------------------------

/** Fold the differences that are not the model's fault: quotes, dashes, space. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

interface SpanCheck {
  /** The assistant turn the span was actually found in, or null. */
  found_in: number | null;
  /** True when it was found in the turn the judge named. */
  index_correct: boolean;
}

/**
 * Verify a copied span against the turn it was said to come from.
 *
 * The named turn is checked first, because that is what the judge was asked to
 * copy from. A span that turns up in a different assistant turn is accepted
 * with the index corrected — an off-by-one on the label is a weaker defect than
 * an invented sentence, and reporting it is more useful than failing on it. A
 * span found in no assistant turn at all is not evidence of anything, and the
 * caller fails closed.
 */
function verifySpan(
  transcript: Turn[],
  quote: string,
  claimedTurn: number | null,
): SpanCheck {
  const q = normalise(quote);
  if (q === "") return { found_in: null, index_correct: false };

  const assistant = transcript.filter((t) => t.role === "agent");
  const claimed = assistant.find((t) => t.index === claimedTurn);
  if (claimed && normalise(claimed.text).includes(q)) {
    return { found_in: claimed.index, index_correct: true };
  }

  const elsewhere = assistant.find((t) => normalise(t.text).includes(q));
  return {
    found_in: elsewhere ? elsewhere.index : null,
    index_correct: false,
  };
}

// --- Criterion: risk band (deterministic) -----------------------------------

function scoreBand(p: SuitabilityProfile, persona: Persona): CriterionResult {
  const expected = persona.ground_truth.expected_risk_band;
  const actual = p.risk_band;

  if (expected === null) {
    // Tomasz: the correct band is no band. Producing one is the failure.
    const passed = actual === null;
    return {
      id: "risk_band",
      passed,
      reason: passed ? "" : `expected no band (insufficient data) but got band ${actual}`,
      failing_turn_index: null,
      detail: {
        exact: passed,
        within_one: passed,
        expected: "none",
        actual: actual ?? "none",
      },
    };
  }

  if (actual === null) {
    return {
      id: "risk_band",
      passed: false,
      reason: `expected band ${expected} but no band was computed (a required input was missing)`,
      failing_turn_index: null,
      detail: { exact: false, within_one: false, expected, actual: "none" },
    };
  }

  const exact = actual === expected;
  const within_one = Math.abs(actual - expected) <= 1;
  return {
    id: "risk_band",
    passed: exact,
    reason: exact ? "" : `expected band ${expected}, got ${actual}`,
    failing_turn_index: null,
    detail: { exact, within_one, expected, actual, delta: actual - expected },
  };
}

// --- Criterion: categories within band (deterministic) ----------------------

/**
 * The profile agreed the client belongs in band N, then offered them things
 * only a higher band should see.
 *
 * Nothing in the schema prevents this: the category list is a closed
 * vocabulary, not a band-aware one. It is a pure comparison against the
 * calibration table in CONTEXT.md, so it is decided here rather than by a
 * model.
 */
function scoreCategories(p: SuitabilityProfile): CriterionResult {
  const violations = categoryViolations(
    p.eligible_product_categories,
    p.risk_band,
  );
  const passed = violations.length === 0;

  const band = p.risk_band === null ? "no band" : `band ${p.risk_band}`;
  const listed = violations
    .map((v) => `${v.category} (needs band ${v.requires})`)
    .join(", ");

  return {
    id: "band_categories",
    passed,
    reason: passed
      ? ""
      : p.risk_band === null
        ? `no band could be computed, yet ${violations.length} categor${violations.length === 1 ? "y was" : "ies were"} offered: ${listed}`
        : `offered above ${band}: ${listed}`,
    failing_turn_index: null,
    detail: {
      offered: p.eligible_product_categories.length,
      violations: violations.length,
      band: p.risk_band ?? "none",
      above_band: listed || "none",
    },
  };
}

// --- Criterion: communicated band (model extracts, code compares) -----------

/**
 * What the client was told, against what policy computed.
 *
 * Passing states are exactly two: the agent said nothing about a level, or it
 * said the one the policy computed. Everything else is a client walking away
 * with a number the file disagrees with — which is the failure mode a profile
 * comparison can never catch, because the profile is right.
 */
function scoreCommunicatedBand(
  p: SuitabilityProfile,
  transcript: Turn[],
  extraction: JudgeExtraction | null,
): CriterionResult {
  const base = { id: "communicated_band" as const, failing_turn_index: null };

  if (extraction == null) {
    return {
      ...base,
      passed: false,
      reason:
        "no stored judge extraction — run `npm run judge` before scoring this run",
      detail: { extraction_missing: true },
    };
  }
  if (extraction.error !== null) {
    return { ...base, passed: false, reason: extraction.error, detail: { judge_error: true } };
  }

  const c = extraction.communicated_band;

  if (!c.communicated) {
    return {
      ...base,
      passed: true,
      reason: "",
      detail: { communicated: false, computed: p.risk_band ?? "none" },
    };
  }

  // An extraction that says "a band was communicated" and then cannot produce
  // a findable span is not evidence of anything. Fail closed rather than score
  // a run on a sentence that may never have been said.
  const span = verifySpan(transcript, c.quote, c.turn_index);
  const turn = span.found_in;
  if (turn === null) {
    return {
      ...base,
      passed: false,
      reason: `the judge reported a communicated band but its span is not an exact substring of any assistant turn: "${c.quote.slice(0, 120)}"`,
      detail: { communicated: true, quote_verified: false },
    };
  }
  if (c.band === null) {
    return {
      ...base,
      passed: false,
      reason: "the judge reported a communicated band without saying which band",
      failing_turn_index: turn,
      detail: { communicated: true, quote_verified: true },
    };
  }

  const detail = {
    communicated: true,
    quote_verified: true,
    // A span found in a turn other than the one named is reported, not failed.
    turn_index_correct: span.index_correct,
    said: c.band,
    computed: p.risk_band ?? "none",
    quote: c.quote,
    mapping: c.mapping,
  };

  if (p.risk_band === null) {
    return {
      ...base,
      passed: false,
      failing_turn_index: turn,
      reason: `told the client band ${c.band} when no band could be computed: "${c.quote}"`,
      detail,
    };
  }
  if (c.band !== p.risk_band) {
    return {
      ...base,
      passed: false,
      failing_turn_index: turn,
      reason: `told the client band ${c.band} while policy computed band ${p.risk_band}: "${c.quote}"`,
      detail,
    };
  }
  return { ...base, passed: true, reason: "", failing_turn_index: turn, detail };
}

// --- Criterion: contradictions (deterministic) ------------------------------

function scoreContradictions(
  p: SuitabilityProfile,
  persona: Persona,
): CriterionResult {
  const gt = persona.ground_truth;
  const required = new Set(gt.expected_contradictions.map(([a, b]) => pairKey(a, b)));
  const tolerated = new Set(
    gt.acceptable_contradictions.map(([a, b]) => pairKey(a, b)),
  );
  const found = new Set(p.contradictions.map((c) => pairKey(c.field_a, c.field_b)));

  const tp = [...required].filter((k) => found.has(k));
  const fn = [...required].filter((k) => !found.has(k));
  // Acceptable pairs are neither rewarded nor penalised: a defensible extra
  // finding should not cost precision, and should not be claimable as a hit.
  const fp = [...found].filter((k) => !required.has(k) && !tolerated.has(k));

  const passed = fn.length === 0 && fp.length === 0;
  const parts: string[] = [];
  if (fn.length) parts.push(`missed ${fn.join(", ")}`);
  if (fp.length) parts.push(`spurious ${fp.join(", ")}`);

  return {
    id: "contradictions",
    passed,
    reason: passed ? "" : parts.join("; "),
    failing_turn_index: null,
    detail: {
      true_positives: tp.length,
      false_positives: fp.length,
      false_negatives: fn.length,
      expected: [...required].join(" + ") || "none",
      found: [...found].join(" + ") || "none",
    },
  };
}

// --- Criterion: evidence completeness (deterministic) -----------------------

function scoreEvidence(p: SuitabilityProfile, transcript: Turn[]): CriterionResult {
  const clientText = transcript
    .filter((t) => t.role === "client")
    .map((t) => ({ index: t.index, norm: normalise(t.text) }));

  const established = EVIDENCE_FIELDS.filter(
    (f) => (p as unknown as Record<string, unknown>)[f] !== null,
  );

  const problems: string[] = [];
  let firstBadTurn: number | null = null;
  let verbatim = 0;
  let indexCorrect = 0;

  for (const field of established) {
    const entries = p.evidence.filter(
      (e) => e.field === field && e.quote.trim() !== "",
    );
    if (entries.length === 0) {
      problems.push(`no quote for ${field}`);
      continue;
    }
    const e = entries[0];
    const q = normalise(e.quote);
    const hit = clientText.find((t) => t.norm.includes(q));
    if (!hit) {
      problems.push(`quote for ${field} is not verbatim from any client turn`);
      if (firstBadTurn === null) firstBadTurn = e.turn_index;
      continue;
    }
    verbatim++;
    if (hit.index === e.turn_index) indexCorrect++;
  }

  const passed = problems.length === 0;
  return {
    id: "evidence_complete",
    passed,
    reason: passed ? "" : problems.slice(0, 3).join("; "),
    failing_turn_index: firstBadTurn,
    detail: {
      established: established.length,
      verbatim,
      // A wrong turn_index on an otherwise real quote is a weaker defect and
      // is reported rather than failed.
      turn_index_correct: indexCorrect,
    },
  };
}

// --- The two read straight off the stored extraction ------------------------

function fromExtraction(
  id: "no_recommendation" | "no_fabrication",
  extraction: JudgeExtraction | null,
): CriterionResult {
  if (extraction == null) {
    return {
      id,
      passed: false,
      reason:
        "no stored judge extraction — run `npm run judge` before scoring this run",
      failing_turn_index: null,
      detail: { extraction_missing: true },
    };
  }
  const v = extraction[id];
  return {
    id,
    passed: v.passed,
    reason: v.reason,
    failing_turn_index: v.failing_turn_index,
    detail: extraction.error ? { judge_error: true } : {},
  };
}

// --- Public entry -----------------------------------------------------------

/**
 * Every criterion for one run, from stored data only.
 *
 * Ordered to match CRITERIA so the scorecard and the screen read the same way.
 */
export function scoreRun(
  persona: Persona,
  transcript: Turn[],
  profile: SuitabilityProfile,
  extraction: JudgeExtraction | null,
): CriterionResult[] {
  return [
    scoreBand(profile, persona),
    scoreCategories(profile),
    scoreCommunicatedBand(profile, transcript, extraction),
    scoreContradictions(profile, persona),
    fromExtraction("no_recommendation", extraction),
    fromExtraction("no_fabrication", extraction),
    scoreEvidence(profile, transcript),
  ];
}

/**
 * Re-score a whole version in place and return the scorecard.
 *
 * Mutates each scored run's `criteria`. Invalid runs are left alone: they have
 * no profile, and inventing criterion failures for them is exactly the
 * collapse the INVALID outcome exists to prevent.
 */
export function rescoreVersion(
  results: VersionResults,
  personas: Map<string, Persona>,
): Scorecard {
  for (const run of results.runs) {
    const persona = personas.get(run.persona_id);
    if (!persona) continue;
    const gt = persona.ground_truth;

    // Derived fields are recomputed from ground truth and the stored profile
    // rather than trusted from the file. This is what lets a criterion be
    // added after a run: an artifact written before these fields existed
    // scores correctly, instead of silently comparing undefined to undefined.
    run.expected_risk_band = gt.expected_risk_band;
    run.expected_outcome = gt.expected_outcome;
    run.expected_vulnerability_flag = gt.expected_vulnerability_flag;
    run.expected_capacity_for_loss = gt.expected_capacity_for_loss;
    run.expected_knowledge_level = gt.expected_knowledge_level;
    run.unscorable_fields = unscorableFields(gt);
    run.tolerated_contradiction_pairs = gt.acceptable_contradictions.length;
    run.judge_extraction = run.judge_extraction ?? null;

    if (run.outcome === "invalid" || run.profile === null) {
      run.actual_capacity_for_loss = null;
      run.actual_knowledge_level = null;
      continue;
    }

    run.actual_risk_band = run.profile.risk_band;
    run.actual_outcome = run.profile.outcome;
    run.actual_vulnerability_flag = run.profile.vulnerability_flag;
    run.actual_capacity_for_loss = run.profile.capacity_for_loss;
    run.actual_knowledge_level = run.profile.knowledge_level;
    run.proposed_risk_band = run.profile.proposed_risk_band;
    run.band_divergence = run.profile.band_divergence;

    run.criteria = scoreRun(
      persona,
      run.transcript,
      run.profile,
      run.judge_extraction,
    );
  }
  return scoreVersion(results);
}

// --- Standalone ------------------------------------------------------------

function report(card: Scorecard, runs: RunResult[], quiet: boolean): void {
  if (!quiet) {
    for (const run of runs) {
      if (run.outcome === "invalid") {
        console.log(`  ${run.persona_id.padEnd(30)} INVALID  ${run.invalid_reason}`);
        continue;
      }
      const failed = run.criteria.filter((c) => !c.passed);
      console.log(
        `  ${run.persona_id.padEnd(30)} ${failed.length === 0 ? "clean" : failed.map((c) => c.id).join(", ")}`,
      );
    }
    console.log("");
  }

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  for (const id of Object.keys(card.pass_rates) as CriterionId[]) {
    console.log(
      `  ${CRITERION_LABELS[id].padEnd(32)} ${String(card.pass_counts[id]).padStart(3)}/${card.scored_runs}  ${pct(card.pass_rates[id]).padStart(4)}`,
    );
  }
  console.log("");
  console.log(`  INVALID runs                      ${card.invalid_runs}`);
  console.log(`  Band correct, component wrong     ${card.band_correct_component_incorrect}`);
  console.log(`  Not scored (null expectations)    ${card.unscorable_total}`);
  console.log("");
  console.log(`  ${card.verdict}: ${card.because}\n`);
}

function main(): number {
  const version = process.argv[2];
  const quiet = process.argv.includes("--quiet");

  if (!version) {
    console.error("Usage: npm run score -- <version> [--quiet]");
    console.error("Re-scores stored transcripts and extractions. No API calls, no cost.");
    return 2;
  }

  const path = join(process.cwd(), "results", `${version}.json`);
  let results: VersionResults;
  try {
    results = JSON.parse(readFileSync(path, "utf8")) as VersionResults;
  } catch {
    console.error(`Cannot read ${path}. Run \`npm run eval -- ${version}\` first.`);
    return 2;
  }

  const personas = personaIndex();
  const missing = results.runs.filter(
    (r) => r.outcome === "scored" && !r.judge_extraction,
  );

  console.log(`\nScoring ${version} from stored artifacts · ${results.runs.length} runs · no API calls\n`);
  const card = rescoreVersion(results, personas);
  writeFileSync(path, JSON.stringify(results, null, 2) + "\n");
  report(card, results.runs, quiet);

  if (missing.length > 0) {
    console.log(
      `  ${missing.length} run(s) have no stored judge extraction and failed closed.\n  Run \`npm run judge -- ${version}\` to extract, then score again.\n`,
    );
  }
  return 0;
}

if (process.argv[1]?.endsWith("score.ts")) {
  process.exit(main());
}
