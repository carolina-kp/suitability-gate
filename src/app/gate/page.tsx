/**
 * The verdict screen.
 *
 * Server-rendered, URL-driven, no client JavaScript: every piece of state —
 * which version, compare mode, which transcript is open — is a query
 * parameter. On a shared screen that means no hydration pause and a URL you
 * can send to someone mid-discussion.
 */
import { readFileSync } from "fs";
import { join } from "path";
import Link from "next/link";
import {
  computeJudgeAgreement,
  CRITERIA,
  CRITERION_LABELS,
  CRITERION_NOTES,
  SAMPLE_CAVEAT,
  scoreVersion,
  VERDICT_RULE,
  type CriterionId,
  type HumanLabel,
  type RunResult,
  type Scorecard,
  type VersionResults,
} from "@/lib/schema";
import {
  formatTokens,
  formatUsd,
  formatUsdPair,
  ROLES,
  totalSpend,
  type Role,
} from "@/lib/config";

export const dynamic = "force-dynamic";

// --- Data -------------------------------------------------------------------

function loadResults(version: string): VersionResults | null {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "results", `${version}.json`), "utf8"),
    ) as VersionResults;
  } catch {
    return null;
  }
}

function loadLabels(): HumanLabel[] {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures", "human_labels.json"), "utf8"),
    ) as { labels?: HumanLabel[] };
    return raw.labels ?? [];
  } catch {
    return [];
  }
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const TONE: Record<string, { ink: string; wash: string }> = {
  GREEN: { ink: "var(--pass)", wash: "var(--pass-wash)" },
  AMBER: { ink: "var(--warn)", wash: "var(--warn-wash)" },
  RED: { ink: "var(--fail)", wash: "var(--fail-wash)" },
};

// --- Pieces -----------------------------------------------------------------

function Verdict({ card, version }: { card: Scorecard; version: string }) {
  const tone = TONE[card.verdict];
  return (
    <div>
      <div className="verdict-rule" style={{ background: tone.ink }} />
      <div className="grid gap-x-10 gap-y-4 px-6 py-7 lg:grid-cols-[auto_1fr] lg:px-10">
        <div>
          <p className="mb-1 text-[0.8125rem] text-ink-soft">
            Intake prompt {version}
          </p>
          <p className="verdict-word" style={{ color: tone.ink }}>
            {card.verdict}
          </p>
        </div>
        <div className="max-w-[62ch] self-end">
          <p className="prose-serif">{card.because}</p>
          <p className="prose-serif mt-3 text-ink-soft" style={{ fontSize: "0.9375rem" }}>
            <span className="font-semibold text-ink">The rule.</span>{" "}
            {VERDICT_RULE}
          </p>
        </div>
      </div>
    </div>
  );
}

function Metric({
  value,
  label,
  detail,
  tone,
}: {
  value: string;
  label: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className="px-5 py-4 first:pl-6 lg:first:pl-10">
      <p
        className="tnum text-[1.75rem] font-semibold leading-none"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[0.8125rem] font-medium">{label}</p>
      {detail ? (
        <p className="text-[0.75rem] text-ink-faint">{detail}</p>
      ) : null}
    </div>
  );
}

function MetricStrip({
  card,
  agreement,
}: {
  card: Scorecard;
  agreement: ReturnType<typeof computeJudgeAgreement>;
}) {
  return (
    <div>
      <div className="flex flex-wrap divide-x divide-rule border-y border-rule bg-card">
        <Metric
          value={`${card.band_exact}/${card.scored_runs}`}
          label="Band exact"
          detail={`${pct(card.band_exact_rate)} of ${card.scored_runs} scored`}
        />
        <Metric
          value={`${card.band_within_one}/${card.scored_runs}`}
          label="Band within one"
          detail={pct(card.band_within_one_rate)}
        />
        <Metric
          value={String(card.invalid_runs)}
          label="Invalid runs"
          detail={
            card.invalid_runs === 0
              ? "none"
              : `of ${card.total_runs}, excluded from rates`
          }
          tone={card.invalid_runs > 0 ? "var(--fail)" : undefined}
        />
        <Metric
          value={`${card.divergence_count}/${card.scored_runs}`}
          label="Model vs policy"
          detail="proposed band differed"
        />
        <Metric
          value={`${card.vulnerability_correct}/${card.vulnerability_scored}`}
          label="Vulnerability flag"
          detail={
            card.unscorable_total === 0
              ? "matched expectation"
              : `matched · ${card.unscorable_total} not scored`
          }
        />
        <Metric
          value={
            agreement.compared === 0
              ? "—"
              : `${agreement.agreed}/${agreement.compared}`
          }
          label="Judge agreement"
          detail={
            agreement.compared === 0
              ? "no hand labels yet"
              : `${pct(agreement.rate)} over ${agreement.labelled_runs} hand-labelled runs`
          }
        />
        <Metric
          value={formatUsd(card.mean_cost_per_conversation)}
          label="Cost per conversation"
          detail={`agent only · ${card.completed_conversations}/${card.total_runs} completed`}
        />
        <Metric
          value={formatUsd(card.cost_total)}
          label="Total run cost"
          detail="agent, client sim and judge"
          tone={card.unpriced_tokens > 0 ? "var(--fail)" : undefined}
        />
      </div>
      <p className="prose-serif border-b border-rule bg-card px-6 py-3 text-ink-soft lg:px-10" style={{ fontSize: "0.9375rem" }}>
        {SAMPLE_CAVEAT}
        {agreement.compared === 0
          ? " The judge is a model and is not yet measured: hand-label a few runs in fixtures/human_labels.json and its agreement rate appears above."
          : ""}
      </p>
    </div>
  );
}

const ROLE_LABEL: Record<Role, string> = {
  agent: "Agent",
  persona: "Client simulator",
  judge: "Judge",
};

const ROLE_NOTE: Record<Role, string> = {
  agent: "the thing under test",
  persona: "test apparatus — would not exist with a real client",
  judge: "test apparatus — scores, does not converse",
};

/**
 * Cost, and what was deliberately left out of the rates above.
 *
 * Both halves exist for the same reason: a number is only readable next to its
 * denominator. "Cost per conversation" means nothing without saying whose
 * tokens are in it, and a pass rate means nothing without saying which cases
 * were excluded from it.
 */
function Ledger({ card, models }: { card: Scorecard; models: Record<Role, string> }) {
  const exclusions: { what: string; detail: string }[] = [];

  for (const [field, ids] of Object.entries(card.unscorable_by_field)) {
    exclusions.push({
      what: `${ids.length} × ${field.replace(/^expected_/, "").replace(/_/g, " ")}`,
      detail: `ground truth is null — either answer is defensible. ${ids.join(", ")}`,
    });
  }
  if (card.tolerated_pairs_total > 0) {
    exclusions.push({
      what: `${card.tolerated_pairs_total} × contradiction pair`,
      detail:
        "defensible but not required: neither rewarded nor penalised, so outside precision",
    });
  }
  if (card.invalid_runs > 0) {
    exclusions.push({
      what: `${card.invalid_runs} × invalid run`,
      detail:
        "no schema-valid profile, so nothing to score — counted as its own finding, not as five failures",
    });
  }

  const [meanAgent, meanHarness] = formatUsdPair(
    card.mean_cost_per_conversation,
    card.mean_harness_cost_per_conversation,
  );

  return (
    <section className="grid border-b border-rule bg-card lg:grid-cols-2 lg:divide-x lg:divide-rule">
      <div className="px-6 py-5 lg:px-10">
        <h2 className="text-[0.9375rem] font-semibold">Cost</h2>
        <div className="overflow-x-auto">
          <table className="ledger mt-1">
            <thead>
              <tr>
                <th className="col-head">Role</th>
                <th className="col-head">In</th>
                <th className="col-head">Out</th>
                <th className="col-head">Cost</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => (
                <tr key={role}>
                  <td>
                    <span className="font-medium">{ROLE_LABEL[role]}</span>
                    <span className="block text-[0.78125rem] text-ink-faint">
                      {models[role]} · {ROLE_NOTE[role]}
                    </span>
                  </td>
                  <td className="tnum align-top">
                    {formatTokens(card.spend[role].input_tokens)}
                  </td>
                  <td className="tnum align-top">
                    {formatTokens(card.spend[role].output_tokens)}
                  </td>
                  <td className="tnum align-top font-semibold">
                    {formatUsd(card.spend[role].cost_usd)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="font-medium">Total</td>
                <td className="tnum align-top">
                  {formatTokens(totalSpend(card.spend).input_tokens)}
                </td>
                <td className="tnum align-top">
                  {formatTokens(totalSpend(card.spend).output_tokens)}
                </td>
                <td className="tnum align-top font-semibold">
                  {formatUsd(card.cost_total)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="prose-serif mt-3 text-ink-soft" style={{ fontSize: "0.9375rem" }}>
          <span className="tnum font-semibold text-ink">{meanAgent}</span> is
          the mean cost of one completed conversation, counting the agent only,
          over {card.completed_conversations} of {card.total_runs} runs. The
          client simulator and the judge are excluded because neither exists
          when a real client is on the other end; including the simulator it is{" "}
          <span className="tnum">{meanHarness}</span>.
        </p>
        {card.unpriced_tokens > 0 ? (
          <p className="prose-serif mt-2 font-semibold" style={{ color: "var(--fail)" }}>
            {formatTokens(card.unpriced_tokens)} tokens were billed by a model
            with no entry in the rates table. Every cost above is understated.
          </p>
        ) : null}
      </div>

      <div className="px-6 py-5 lg:px-10">
        <h2 className="text-[0.9375rem] font-semibold">
          Not scored
          <span className="ml-2 font-normal text-ink-soft">
            {card.unscorable_total} null expectation
            {card.unscorable_total === 1 ? "" : "s"}
          </span>
        </h2>
        {exclusions.length === 0 ? (
          <p className="prose-serif mt-2 text-ink-soft">
            Every case is scored. Nothing sits outside a denominator.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-rule">
            {exclusions.map((e) => (
              <li key={e.what} className="py-2">
                <span className="tnum font-medium">{e.what}</span>
                <span className="block text-[0.8125rem] text-ink-soft">
                  {e.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Colour only where it carries the verdict. A clean sheet reads green; a gap in
 * one of the two disqualifying criteria reads red, because that is what turned
 * the light red. Everything else stays in ink — a column of red numbers would
 * say nothing.
 */
const DISQUALIFYING: CriterionId[] = ["no_recommendation", "no_fabrication"];

function rateTone(id: CriterionId, card: Scorecard) {
  if (card.pass_rates[id] === 1) return { color: "var(--pass)" };
  if (DISQUALIFYING.includes(id)) return { color: "var(--fail)" };
  return undefined;
}

/**
 * The number under a criterion that a pass rate alone would hide: what the
 * near-misses look like, and how many cases sit outside the denominator.
 */
function criterionAside(id: CriterionId, card: Scorecard): string | null {
  if (id === "risk_band") {
    return `within one: ${card.band_within_one}/${card.scored_runs} (${pct(card.band_within_one_rate)})`;
  }
  if (id === "contradictions") {
    const parts = [
      `precision ${pct(card.contradiction_precision)}`,
      `recall ${pct(card.contradiction_recall)}`,
    ];
    if (card.tolerated_pairs_total > 0) {
      parts.push(
        `${card.tolerated_pairs_total} acceptable pairs excluded from precision`,
      );
    }
    return parts.join(" · ");
  }
  return null;
}

function Scorecard1({ card }: { card: Scorecard }) {
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th className="col-head">Criterion</th>
          <th className="col-head">Passed</th>
          <th className="col-head">Rate</th>
        </tr>
      </thead>
      <tbody>
        {CRITERIA.map((id) => (
          <tr key={id}>
            <td>
              <span className="font-medium">{CRITERION_LABELS[id]}</span>
              <span className="block text-[0.78125rem] text-ink-faint">
                {CRITERION_NOTES[id]}
              </span>
              {criterionAside(id, card) ? (
                <span className="tnum block text-[0.78125rem] text-ink-soft">
                  {criterionAside(id, card)}
                </span>
              ) : null}
            </td>
            <td className="tnum align-top">
              {card.pass_counts[id]}/{card.scored_runs}
            </td>
            <td className="tnum align-top font-semibold" style={rateTone(id, card)}>
              {pct(card.pass_rates[id])}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScorecardCompare({ a, b }: { a: Scorecard; b: Scorecard }) {
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th className="col-head">Criterion</th>
          <th className="col-head">v1</th>
          <th className="col-head">v2</th>
          <th className="col-head">Change</th>
        </tr>
      </thead>
      <tbody>
        {CRITERIA.map((id) => {
          const d = b.pass_rates[id] - a.pass_rates[id];
          return (
            <tr key={id}>
              <td>
                <span className="font-medium">{CRITERION_LABELS[id]}</span>
                <span className="block text-[0.78125rem] text-ink-faint">
                  {CRITERION_NOTES[id]}
                </span>
              </td>
              <td className="tnum align-top text-ink-soft">
                {a.pass_counts[id]}/{a.scored_runs}
              </td>
              <td className="tnum align-top font-semibold">
                {b.pass_counts[id]}/{b.scored_runs}
              </td>
              <td
                className="tnum align-top font-semibold"
                style={{
                  color:
                    d > 0 ? "var(--pass)" : d < 0 ? "var(--fail)" : "var(--ink-faint)",
                }}
              >
                {d === 0 ? "no change" : `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)} pts`}
              </td>
            </tr>
          );
        })}
        <tr>
          <td className="font-medium">
            Band exact
            <span className="block text-[0.78125rem] text-ink-faint">
              reported, but not what turns the light red
            </span>
          </td>
          <td className="tnum align-top text-ink-soft">
            {a.band_exact}/{a.scored_runs}
          </td>
          <td className="tnum align-top font-semibold">
            {b.band_exact}/{b.scored_runs}
          </td>
          <td className="tnum align-top font-semibold">
            {b.band_exact_rate === a.band_exact_rate
              ? "no change"
              : `${b.band_exact_rate > a.band_exact_rate ? "+" : ""}${((b.band_exact_rate - a.band_exact_rate) * 100).toFixed(0)} pts`}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function bandStory(run: RunResult): string | null {
  const p = run.profile;
  if (!p || p.risk_band === null) return null;
  const names: Record<string, string> = {
    stated_risk_tolerance: "what they said",
    behavioural_loss_tolerance: "what they would do",
    capacity_cap: "what they can afford to lose",
    horizon_cap: "when they need the money",
  };
  const bound = p.binding.map((b) => names[b] ?? b).join(" and ");
  const caps = Object.entries(p.caps)
    .map(([k, v]) => `${names[k] ?? k} ${v}`)
    .join(" · ");
  return `Band ${p.risk_band}, set by ${bound}. Ceilings: ${caps}.`;
}

function RunList({
  card,
  version,
  compare,
  openId,
}: {
  card: Scorecard;
  version: string;
  compare: boolean;
  openId: string | null;
}) {
  const rows = [...card.invalid_run_list, ...card.failing_runs];
  if (rows.length === 0) {
    return (
      <p className="prose-serif p-6 text-ink-soft">
        Every run passed every criterion. Nothing to open.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-rule">
      {rows.map((run) => {
        const failed = run.criteria.filter((c) => !c.passed);
        const open = run.persona_id === openId;
        const href = `/gate?v=${version}${compare ? "&compare=1" : ""}&run=${run.persona_id}`;
        return (
          <li key={run.persona_id}>
            <Link
              href={href}
              scroll={false}
              className="block px-5 py-3 hover:bg-paper"
              style={open ? { background: "var(--paper)" } : undefined}
              aria-current={open ? "true" : undefined}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {run.persona_name}
                  {run.adversarial ? (
                    <span className="ml-2 text-[0.75rem] font-normal text-ink-faint">
                      adversarial
                    </span>
                  ) : null}
                </span>
                <span
                  className="tnum text-[0.8125rem] font-semibold"
                  style={{ color: "var(--fail)" }}
                >
                  {run.outcome === "invalid"
                    ? "INVALID"
                    : `${failed.length} failed`}
                </span>
              </div>
              <p className="mt-0.5 text-[0.8125rem] text-ink-soft">
                {run.outcome === "invalid"
                  ? run.invalid_reason
                  : failed.map((c) => CRITERION_LABELS[c.id]).join(", ")}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Transcript({ run }: { run: RunResult }) {
  const flagged = new Map<number, string[]>();
  for (const c of run.criteria) {
    if (c.passed || c.failing_turn_index === null) continue;
    const list = flagged.get(c.failing_turn_index) ?? [];
    list.push(`${CRITERION_LABELS[c.id]}: ${c.reason}`);
    flagged.set(c.failing_turn_index, list);
  }

  const noTurn = run.criteria.filter(
    (c) => !c.passed && c.failing_turn_index === null,
  );
  const story = bandStory(run);

  return (
    <div>
      <div className="border-b border-rule px-5 py-4">
        <h3 className="text-[1.0625rem] font-semibold">
          {run.persona_name} · {run.persona_id}
        </h3>
        {story ? (
          <p className="prose-serif mt-1 text-ink-soft" style={{ fontSize: "0.9375rem" }}>
            {story}
          </p>
        ) : null}
        {run.outcome === "invalid" ? (
          <p className="prose-serif mt-1" style={{ color: "var(--fail)" }}>
            Invalid: {run.invalid_reason}
          </p>
        ) : null}
        {run.band_divergence !== null && run.band_divergence !== 0 ? (
          <p className="prose-serif mt-1 text-ink-soft" style={{ fontSize: "0.9375rem" }}>
            The model proposed band {run.proposed_risk_band}; policy computed{" "}
            {run.actual_risk_band}.
          </p>
        ) : null}
        {noTurn.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {noTurn.map((c) => (
              <li
                key={c.id}
                className="prose-serif"
                style={{ fontSize: "0.9375rem", color: "var(--fail)" }}
              >
                {CRITERION_LABELS[c.id]}: {c.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ol className="divide-y divide-rule">
        {run.transcript.map((turn) => {
          const notes = flagged.get(turn.index);
          return (
            <li
              key={turn.index}
              className={`px-5 py-3 ${notes ? "turn-flag" : ""}`}
            >
              <p className="mb-1 text-[0.75rem] font-semibold text-ink-faint">
                {turn.index} · {turn.role === "agent" ? "Agent" : run.persona_name}
              </p>
              <p className="prose-serif whitespace-pre-wrap">{turn.text}</p>
              {notes?.map((n) => (
                <p
                  key={n}
                  className="prose-serif mt-2 font-semibold"
                  style={{ fontSize: "0.9375rem", color: "var(--fail)" }}
                >
                  {n}
                </p>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Empty() {
  return (
    <main className="mx-auto max-w-[64ch] px-6 py-20">
      <h1 className="text-4xl font-extrabold tracking-tight">No results yet</h1>
      <p className="prose-serif mt-4">
        This screen reads <code>results/v1.json</code> and{" "}
        <code>results/v2.json</code>. Neither exists, so there is nothing to
        report — and reporting a verdict without runs behind it is the one thing
        this page must never do.
      </p>
      <ol className="prose-serif mt-6 space-y-2">
        <li>
          1. Put an <code>ANTHROPIC_API_KEY</code> in <code>.env.local</code>.
        </li>
        <li>
          2. Leave <code>npm run dev</code> running in this terminal.
        </li>
        <li>
          3. In a second terminal, run <code>npm run eval -- v1 v2</code>.
        </li>
      </ol>
      <p className="prose-serif mt-6 text-ink-soft">
        Add <code>--dry-run</code> to check the fixtures load and the app is
        reachable without spending anything.
      </p>
    </main>
  );
}

// --- Page -------------------------------------------------------------------

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const v1 = loadResults("v1");
  const v2 = loadResults("v2");
  if (!v1 && !v2) return <Empty />;

  const available = [v1, v2].filter((r): r is VersionResults => r !== null);
  const requested = one("v");
  const current =
    available.find((r) => r.version === requested) ?? available.at(-1)!;
  const compare = one("compare") === "1" && v1 !== null && v2 !== null;
  const openId = one("run") ?? null;

  const card = scoreVersion(current);
  const labels = loadLabels();
  const agreement = computeJudgeAgreement(current.version, current.runs, labels);

  const openRun =
    current.runs.find((r) => r.persona_id === openId) ??
    card.invalid_run_list[0] ??
    card.failing_runs[0] ??
    null;

  const tab = (label: string, href: string, active: boolean) => (
    <Link
      key={label}
      href={href}
      className="border-b-2 px-3 py-1 text-[0.875rem] font-medium"
      style={{
        borderColor: active ? "var(--ink)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-soft)",
      }}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-6 py-3 lg:px-10">
        <h1 className="text-[0.9375rem] font-semibold">
          Suitability gate{" "}
          <span className="ml-3 font-normal text-ink-soft">
            twenty client personas, five criteria
          </span>
        </h1>
        <nav className="flex items-center gap-1" aria-label="Prompt version">
          {available.map((r) =>
            tab(
              r.version,
              `/gate?v=${r.version}${openId ? `&run=${openId}` : ""}`,
              !compare && r.version === current.version,
            ),
          )}
          {v1 && v2
            ? tab(
                "compare",
                `/gate?v=${current.version}&compare=1${openId ? `&run=${openId}` : ""}`,
                compare,
              )
            : null}
        </nav>
        <p className="text-[0.8125rem] text-ink-soft">
          agent {current.models.agent} · judge {current.models.judge} · client{" "}
          {current.models.persona}
        </p>
      </header>

      {compare && v1 && v2 ? (
        <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-rule">
          <Verdict card={scoreVersion(v1)} version="v1" />
          <Verdict card={scoreVersion(v2)} version="v2" />
        </div>
      ) : (
        <Verdict card={card} version={current.version} />
      )}

      <MetricStrip card={card} agreement={agreement} />

      <Ledger card={card} models={current.models} />

      <section className="border-b border-rule bg-card">
        <h2 className="px-6 pt-5 pb-2 text-[0.9375rem] font-semibold lg:px-10">
          {compare ? "Criteria, v1 against v2" : "Criteria"}
        </h2>
        <div className="px-6 pb-4 lg:px-10">
          {compare && v1 && v2 ? (
            <ScorecardCompare a={scoreVersion(v1)} b={scoreVersion(v2)} />
          ) : (
            <Scorecard1 card={card} />
          )}
        </div>
      </section>

      <section className="grid lg:grid-cols-[minmax(300px,26rem)_1fr] lg:divide-x lg:divide-rule">
        <div>
          <h2 className="border-b border-rule px-5 py-3 text-[0.9375rem] font-semibold">
            Runs needing attention
            <span className="ml-2 font-normal text-ink-soft">
              {card.invalid_runs + card.failing_runs.length} of {card.total_runs}
            </span>
          </h2>
          <RunList
            card={card}
            version={current.version}
            compare={compare}
            openId={openRun?.persona_id ?? null}
          />
        </div>
        <div className="bg-card">
          {openRun ? (
            <Transcript run={openRun} />
          ) : (
            <p className="prose-serif p-6 text-ink-soft">
              Select a run to read its transcript.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
