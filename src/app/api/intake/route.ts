/**
 * The intake agent, exposed as one stateless step of a conversation.
 *
 * POST a transcript, get back the agent's next message. When the agent decides
 * it has enough — or the turn budget runs out — the same response carries the
 * extracted suitability profile.
 *
 * Stateless on purpose: the eval harness drives this route over HTTP exactly
 * as a UI would (argus's eval hits the live backend rather than importing the
 * service), so what gets scored is the deployed route, not a library function
 * that happens to sit next to it.
 */
import * as z from "zod/v4";
import {
  DEFAULT_VERSION,
  extractProfile,
  isVersion,
  MAX_TURNS,
  nextTurn,
  VERSIONS,
} from "@/lib/agent";
import { LLMError } from "@/lib/llm";
import { addSpend, emptySpend, modelFor, rateFor } from "@/lib/config";
import type { Turn } from "@/lib/schema";

const turnSchema = z.object({
  role: z.enum(["agent", "client"]),
  text: z.string(),
  index: z.number().int().min(0),
});

const bodySchema = z.object({
  version: z.enum(VERSIONS).optional(),
  transcript: z.array(turnSchema).max(2 * MAX_TURNS + 2).optional(),
  /**
   * Swap the arm for this request. Defaults to the configured agent model.
   * Validated against the rates table below rather than passed through: a
   * model with no known price would produce a run whose cost cannot be
   * computed, and a $0.00 that is really "we don't know" is worse than a
   * refusal.
   */
  agent_model: z.string().min(1).optional(),
});

export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        {
          error: `Invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const version = isVersion(body.version) ? body.version : DEFAULT_VERSION;

  const agentModel = body.agent_model ?? modelFor("agent");
  if (rateFor(agentModel) === null) {
    return Response.json(
      {
        error: `No rate is configured for "${agentModel}". Add it to RATES in src/lib/config.ts — a run whose cost cannot be computed must not report one.`,
      },
      { status: 400 },
    );
  }

  const transcript: Turn[] = (body.transcript ?? []).map((t, i) => ({
    ...t,
    index: i, // re-index server-side so evidence indices can never be spoofed
  }));

  try {
    const turn = await nextTurn(version, transcript, agentModel);
    let spend = turn.completion.spend;

    const agentTurn: Turn = {
      role: "agent",
      text: turn.message,
      index: transcript.length,
    };

    if (!turn.done) {
      return Response.json({
        version,
        // What actually ran, not what was asked for — the results file records
        // the observed model rather than the harness's assumption.
        agent_model: turn.completion.model,
        turn: agentTurn,
        done: false,
        profile: null,
        error: null,
        invariant_problems: [],
        spend,
      });
    }

    const full = [...transcript, agentTurn];
    const extraction = await extractProfile(version, full, agentModel);
    spend = addSpend(spend, extraction.completion.spend);

    return Response.json({
      version,
      agent_model: extraction.completion.model,
      turn: agentTurn,
      done: true,
      profile: extraction.profile,
      error: extraction.error,
      invariant_problems: extraction.invariant_problems,
      spend,
    });
  } catch (err) {
    // A missing key or an exhausted retry chain is an infrastructure failure,
    // not a bad score. Say so explicitly so the harness records it as an error
    // rather than folding it into a run's result.
    const message =
      err instanceof LLMError ? err.message : "The intake agent is unavailable.";
    return Response.json(
      { error: message, version, agent_model: agentModel, spend: emptySpend() },
      { status: 503 },
    );
  }
}
