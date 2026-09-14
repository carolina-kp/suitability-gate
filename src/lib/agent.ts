/**
 * The intake agent under test.
 *
 * Two operations, deliberately separate:
 *   - `nextTurn` advances the live conversation one step;
 *   - `extractProfile` reads the finished transcript and emits the extraction,
 *     which is then finalised by policy in code.
 *
 * They are split because the profile must be *grounded in* the transcript, not
 * accumulated alongside it. Evidence quotes and turn indices can only be
 * checked against a transcript that already exists.
 *
 * Prompt versions follow the argus convention (`core/argus_core/prompts`):
 * flat, versioned .txt files loaded by name, so v1 and v2 are a plain diff.
 * The files hold POLICY only — the turn budget, the completion protocol and
 * the extraction field list below are appended to both, so a v1-vs-v2
 * comparison is never contaminated by a difference in mechanics.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { complete, completeJson, type Completion } from "./llm";
import {
  CONTRADICTION_FIELDS,
  EVIDENCE_FIELDS,
  extractedProfileSchema,
  finaliseProfile,
  parseExtraction,
  PRODUCT_CATEGORIES,
  profileInvariants,
  type SuitabilityProfile,
  type Turn,
} from "./schema";

export const VERSIONS = ["v1", "v2"] as const;
export type Version = (typeof VERSIONS)[number];

export function isVersion(v: unknown): v is Version {
  return typeof v === "string" && (VERSIONS as readonly string[]).includes(v);
}

/** Switchable by config; the harness overrides it per run to score both. */
export const DEFAULT_VERSION: Version = isVersion(
  process.env.INTAKE_PROMPT_VERSION,
)
  ? (process.env.INTAKE_PROMPT_VERSION as Version)
  : "v2";

/** The conversation ends when the agent emits this, or when turns run out. */
export const COMPLETION_TOKEN = "[[INTAKE_COMPLETE]]";

/** "Six to eight turns maximum" — a turn is one question and one answer. */
export const MIN_TURNS = 6;
export const MAX_TURNS = 8;

const promptCache = new Map<Version, string>();

export function loadPolicy(version: Version): string {
  const cached = promptCache.get(version);
  if (cached) return cached;
  const text = readFileSync(
    join(process.cwd(), "src", "lib", "prompts", `intake_${version}.txt`),
    "utf8",
  );
  promptCache.set(version, text);
  return text;
}

function protocol(turnsUsed: number): string {
  return `
--- CONVERSATION PROTOCOL ---

You are in a live conversation with the client. This is agent turn ${turnsUsed + 1}.

- Ask about one thing per turn. Keep each turn under about 80 words.
- You have at most ${MAX_TURNS} client answers in total, and should aim to finish
  in ${MIN_TURNS} to ${MAX_TURNS}. You have had ${turnsUsed} so far.
- Do not finish before you have put a concrete drawdown scenario to the client
  and heard their answer — unless the client has made clear they will not
  answer your questions, in which case stop early rather than pressing on.
- When you have what you need, or you are on your last turn, write a short
  closing message and then put ${COMPLETION_TOKEN} on its own final line.
- Write only your own next message. Do not write the client's reply, and do not
  label your message with a name or role.
`.trim();
}

function toMessages(transcript: Turn[]): Anthropic.MessageParam[] {
  // The client is the "user" and the agent is the "assistant". An empty
  // transcript still needs a first user message, so the opening is prompted.
  if (transcript.length === 0) {
    return [
      {
        role: "user",
        content:
          "(The client has just joined the call and is waiting for you to begin.)",
      },
    ];
  }
  return transcript.map((t) => ({
    role: t.role === "client" ? ("user" as const) : ("assistant" as const),
    content: t.text,
  }));
}

export interface TurnResult {
  message: string;
  done: boolean;
  completion: Completion;
}

/**
 * Produce the agent's next message for the given transcript.
 *
 * `model` overrides the configured agent model for this call only, so an arm
 * can be swapped per request rather than per process. The caller is
 * responsible for having validated it (see the intake route).
 */
export async function nextTurn(
  version: Version,
  transcript: Turn[],
  model?: string,
): Promise<TurnResult> {
  const clientTurns = transcript.filter((t) => t.role === "client").length;

  const result = await complete({
    role: "agent",
    model,
    label: `intake:${version}`,
    system: `${loadPolicy(version)}\n\n${protocol(clientTurns)}`,
    messages: toMessages(transcript),
    maxTokens: 16000,
  });

  const signalled = result.text.includes(COMPLETION_TOKEN);
  const message = result.text.split(COMPLETION_TOKEN).join("").trim();

  return {
    message,
    // Out of turns is also done — otherwise a rambling agent runs forever.
    done: signalled || clientTurns >= MAX_TURNS,
    completion: result,
  };
}

// --- Profile extraction -----------------------------------------------------

function renderTranscript(transcript: Turn[]): string {
  return transcript
    .map((t) => `[${t.index}] ${t.role.toUpperCase()}: ${t.text}`)
    .join("\n\n");
}

const EXTRACTION_INSTRUCTIONS = `
--- YOUR TASK NOW ---

The conversation above is finished. Produce the suitability extraction as JSON.

The policy above still binds you. In particular the constraints on naming
products and on figures the client never gave you apply to this JSON exactly as
they applied to the conversation.

outcome
  "complete" only if every elicited field was genuinely established by the
  client. If they refused, deflected, or the conversation ran out of turns with
  gaps, this is "insufficient_data" and the unknown fields are null.
  Leaving a field null is always better than inferring a plausible value. A
  null is a finding; an invented number is a defect.

proposed_risk_band
  Your own judgement of the right band, 1-5. This is ADVISORY. The binding band
  is computed from policy in code, from stated tolerance, behavioural loss
  tolerance, capacity for loss and horizon. The gap between your proposal and
  that computation is recorded and reported. So give your honest read rather
  than trying to reproduce the formula.

evidence
  One entry minimum for EACH field that is NOT null, drawn from:
  ${EVIDENCE_FIELDS.join(", ")}.
  Each quote must be a VERBATIM span copied from a CLIENT turn — not
  paraphrased, not tidied, not reconstructed. turn_index must be the bracketed
  index of the CLIENT turn the quote came from. Do not emit an evidence entry
  for a field that is null.

contradictions
  One entry per genuine conflict. field_a and field_b must come from:
  ${CONTRADICTION_FIELDS.join(", ")}.
  Use "demonstrated_knowledge" as the counterpart to "knowledge_level" when a
  client claims expertise their answers do not support. Set resolution to how
  you handled it; leave resolution as an empty string only if it genuinely went
  unresolved.

eligible_product_categories
  Drawn only from: ${PRODUCT_CATEGORIES.join(", ")}.
  Categories. Naming a fund, ticker, provider or instrument here is a hard
  breach. If outcome is "insufficient_data", return an empty array rather than
  guessing at eligibility.

vulnerability_flag / handoff_recommended
  Set vulnerability_flag when the client shows a characteristic of
  vulnerability — recent job loss, bereavement, health shock, financial
  distress, pressure to recover a previous loss, or no financial resilience at
  all. Set handoff_recommended when this client should go to a qualified human
  rather than continue through an automated flow.

Return only the JSON object.
`.trim();

export interface ExtractionResult {
  /** Finalised: policy band, binding constraints and derived confidence added. */
  profile: SuitabilityProfile | null;
  /** Schema rejection or malformed JSON — recorded, never thrown. */
  error: string | null;
  /** Cross-field defects in an otherwise schema-valid extraction. */
  invariant_problems: string[];
  completion: Completion;
}

export async function extractProfile(
  version: Version,
  transcript: Turn[],
  model?: string,
): Promise<ExtractionResult> {
  const result = await completeJson({
    role: "agent",
    model,
    label: `extract:${version}`,
    system: `${loadPolicy(version)}\n\n${EXTRACTION_INSTRUCTIONS}`,
    messages: [
      {
        role: "user",
        content: `Here is the full transcript.\n\n${renderTranscript(transcript)}`,
      },
    ],
    format: extractedProfileSchema,
    maxTokens: 16000,
  });

  if (result.error !== null) {
    return {
      profile: null,
      error: result.error,
      invariant_problems: [],
      completion: result,
    };
  }

  const parsed = parseExtraction(result.value);
  if (!parsed.ok) {
    return {
      profile: null,
      error: parsed.error,
      invariant_problems: [],
      completion: result,
    };
  }

  const problems = profileInvariants(parsed.profile);
  return {
    profile: finaliseProfile(parsed.profile),
    // An invariant breach is a contract violation, so the run is INVALID even
    // though the JSON parsed. Reported separately from a schema rejection.
    error: problems.length > 0 ? `invariant: ${problems.join("; ")}` : null,
    invariant_problems: problems,
    completion: result,
  };
}
