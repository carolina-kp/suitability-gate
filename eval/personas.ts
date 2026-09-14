/**
 * The fixtures, and what is deliberately not scored about them.
 *
 * Split out of the runner so that scoring, judging and running each import
 * ground truth without importing each other. `npm run score` must be able to
 * recompute every criterion from a stored transcript without so much as
 * loading the code that makes an API call.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

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

export function personaIndex(): Map<string, Persona> {
  return new Map(loadPersonas().map((p) => [p.id, p]));
}

/**
 * Ground-truth expectations that are excluded from a denominator when null.
 *
 * `expected_risk_band: null` is deliberately NOT here. Tomasz's null is a
 * scored expectation — the right answer is "no band", and producing one is the
 * failure. A field belongs on this list only when null means "either answer is
 * defensible, so do not score it", or "this client never established it, so
 * there is nothing to agree with".
 */
export const UNSCORABLE_WHEN_NULL = [
  "expected_vulnerability_flag",
  "expected_capacity_for_loss",
  "expected_knowledge_level",
] as const;

export function unscorableFields(gt: GroundTruth): string[] {
  return UNSCORABLE_WHEN_NULL.filter((f) => gt[f] === null);
}
