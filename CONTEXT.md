# Assumed calibration and stated limits

Everything in this file is an assumption I made so the demo could run. None of
it is a regulatory standard. A real firm substitutes its own numbers; the point
of the exercise is that the numbers live in one testable function
(`computeRiskBand` in `src/lib/schema.ts`) rather than dissolved into a system
prompt where nobody can find them or test them.

## The risk band policy

```
risk_band = min(
  stated_risk_tolerance,       // what the client says
  behavioural_loss_tolerance,  // what they would do in a drawdown
  capacity_cap,                // what they can afford to lose
  horizon_cap                  // when they need the money
)
```

The first two are readings of willingness. The last two are **ceilings**, not
inputs to average against. This distinction is the whole rule: a client can be
entirely willing to ride out a fall, and mean it, and still not belong in band 4
if the money is a flat deposit due in eighteen months. Temperament does not move
a deadline.

### Capacity ceiling

| capacity_for_loss | ceiling |
|---|---|
| low | 2 |
| medium | 4 |
| high | 5 |

### Horizon ceiling

| horizon | ceiling |
|---|---|
| under 2 years | 1 |
| 2–4 years | 2 |
| 5–9 years | 3 |
| 10 years or more | 5 |

Both tables are my invention, chosen to be defensible rather than authoritative.
They are asserted in `eval/policy.test.ts`, so changing a number here fails the
test suite immediately instead of silently shifting twenty runs.

### Why the model does not compute this

The model emits `proposed_risk_band` — its own honest read — and the code
computes the binding band. The gap between them is reported as **divergence**.

A policy you cannot unit-test is not a policy. Moving the rule into code buys
three things: it can be tested without spending a token, it can be diffed and
reviewed like any other rule, and divergence becomes a measurement — it tells
you when the model's judgement disagrees with the rule, which is a signal worth
having rather than a disagreement you never see.

## Derived confidence

`confidence` is **not** self-reported. A model scoring its own confidence 0–1 is
noise that nothing can be graded against. It is computed from things that are
observable:

```
confidence = (evidence coverage × profile completeness)
           − 0.10 per unresolved contradiction
           − 0.15 if the model's proposed band diverged from policy
```

clamped to [0, 1]. Coverage is the share of established fields carrying a
verbatim quote; completeness is the share of the seven fields established at
all. An intake that ran out of turns cannot report high confidence, by
construction.

## Limits worth saying out loud

**Sample size.** n=20. Each persona is five percentage points. Twenty personas
is enough to catch a systematic failure and not enough to certify a rate. A real
gate needs a few hundred. This is why the verdict does not turn red on band
accuracy alone — a light that flips on one case is not a verdict.

**The judge is a model.** Scored by Opus 5 while the agent runs on Sonnet 5,
deliberately different models, because a model grading its own output carries a
self-preference bias. Judge agreement against hand-labelled runs is reported on
the /gate screen; without that number the judge is an unmeasured instrument.

**Personas are simulated.** A Haiku-played client is not a real client. The
adversarial six are hand-written to probe specific failure modes; they are not a
sample of anything.

**The product-name boundary is enforced by validation, not by the schema.** The
structured-output format constrains types and required keys, not value sets, so
a named product in `eligible_product_categories` is *caught and rejected* rather
than made impossible. The conversational side has no schema at all, which is why
the judge reads every assistant turn.
