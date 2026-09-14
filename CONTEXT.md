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

## What each band may be offered

The band constrains the conversation, not just the file. Two tables below make
that checkable.

### Product categories

The lowest band at which each category becomes eligible. A client in band N may
be offered any category at N or below; a profile listing a category **above**
its own computed band is a failure, scored as `band_categories`.

| Band | Categories that become eligible |
|---|---|
| 1 | cash and equivalents, money market |
| 2 | government bonds, investment grade bonds, multi-asset conservative |
| 3 | multi-asset balanced |
| 4 | high yield bonds, multi-asset growth, developed market equity, global equity, listed property, structured products |
| 5 | emerging market equity, commodities, private markets, leveraged or derivative |

Sixteen categories, asserted in `eval/score.test.ts`. Two calls worth stating
because a firm might make them differently: government bonds sit at 2 rather
than 1 because the category says nothing about duration and a long-dated bond
fund is not capital preservation; structured products sit at 4 rather than 5
because the category spans capital-protected notes as well as aggressive ones.

A **null band with a non-empty category list is also a violation**. Eligibility
cannot be asserted for a client whose band could not be computed — that is the
Tomasz case, where a client who would not answer must not leave with a product
list.

### Band vocabulary

What each band is called in words, used when checking that the level an agent
stated to a client matches the one policy computed:

| Band | Words |
|---|---|
| 1 | capital preservation, no risk to capital |
| 2 | cautious, conservative, defensive |
| 3 | moderate, balanced, medium |
| 4 | growth, adventurous, higher risk |
| 5 | maximum growth, aggressive, full equity risk |

This mapping is the weakest assumption in the file, and the one most worth
arguing with: "moderate" is doing real work as band 3, and a firm whose house
scale runs 1-7, or whose "balanced" means something else, would score
differently. It is written down here rather than left inside a prompt precisely
so that the argument is possible.

The judge is given this table and asked only **what the agent said** — never
whether it was consistent, and never shown the computed band. The comparison
happens in code. Repeating a client's own self-rating back to them ("you said
you're a four out of five") is explicitly not a communicated band; assigning
one ("I'd put you in a moderate risk band") is.

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

**The judge is a model.** Scored by Sonnet 5 while the agent runs on Haiku 4.5,
deliberately different models, because a model grading its own output carries a
self-preference bias. Judge agreement against hand-labelled runs is reported on
the /gate screen; without that number the judge is an unmeasured instrument.

**The client simulator shares the agent's model.** Both are Haiku 4.5. This is
a weaker version of the same concern and is worth stating rather than hiding: a
client played by the same model that is answering may be an unusually
cooperative conversational partner, which would make the conversation easier
than a real one. It is not a *grading* relationship, which is the one that
would corrupt a score — the judge is a different model, and three of the five
criteria are decided in code. If a later run puts the client simulator on a
different provider, this limit goes away; the argus Gemini client does not port
cleanly, being one-shot `(system, user)` with no usage accounting, and usage
accounting is now load-bearing.

**Personas are simulated.** A Haiku-played client is not a real client. The
adversarial six are hand-written to probe specific failure modes; they are not a
sample of anything.

**Cost is measured, not estimated.** Tokens are counted per role per run from
the API's own usage figures and converted through the rates table in
`src/lib/config.ts`. Two things follow. The per-conversation figure counts the
**agent only** — the client simulator and the judge are test apparatus, and a
"cost per conversation" that included them would be a number nobody could act
on. And a model with no rate is a hard stop: the eval refuses to start rather
than reporting a cost of $0.00 that means "we don't know".

**Some cases are deliberately not scored.** Ilona's vulnerability flag, eleven
acceptable-but-not-required contradiction pairs, and any invalid run are
excluded from the denominators they would otherwise feed, because in each the
opposite answer is defensible and scoring it would punish a judgement call.
Quietly shrinking a denominator is a way of making a rate look better, so the
count is on the screen next to the rate it affects, with the personas named.
Tomasz's null band is *not* one of these: there the right answer is "no band",
and producing one is the failure, so it stays in the denominator.

**A correct profile can sit next to an incorrect conversation.** This is why
two of the seven criteria read the transcript rather than the file. The band a
client is *told* and the categories they are *offered* are both things the
extraction schema is incapable of constraining — the profile can be entirely
right while the client walks away with a different number in their head. Both
are now scored, and both are disqualifying.

**Component readings are reported, not gated.** `capacity_for_loss` and
`knowledge_level` are compared against ground truth and shown as their own
rates, never as pass/fail. A band can be right for the wrong reason: Ana's
capacity was read as medium against a ground truth of low, and the band was
still correct because the horizon ceiling bound it. The screen counts that case
explicitly — **band correct, component incorrect** — because on a larger sample
it is the number that says whether band accuracy is real or whether the
ceilings are quietly doing all the work.

**The product-name boundary is enforced by validation, not by the schema.** The
structured-output format constrains types and required keys, not value sets, so
a named product in `eligible_product_categories` is *caught and rejected* rather
than made impossible. The conversational side has no schema at all, which is why
the judge reads every assistant turn.
