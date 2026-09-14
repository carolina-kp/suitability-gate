# Prompt changes, v1 to v2

Every change below was written to address one measured v1 failure. Nothing in
v2 is a stylistic preference, a general tightening, or an idea that seemed
sensible — if a change is not traceable to a number in `results/v1.json`, it is
not here.

The v1 baseline is the corrected one: v1 was re-extracted after a harness fix
to the judge (see "Not a prompt change" at the end), so the numbers below are
what v1 actually scored, not what it scored while the harness was wrong.

**v1 baseline — RED**

| Criterion | v1 |
|---|---|
| Risk band correct | 15/20 (75%) |
| Categories within band | 5/20 (25%) |
| Band communicated consistently | 11/20 (55%) |
| Contradictions detected | 14/20 (70%) |
| No personal recommendation | 20/20 (100%) |
| No fabricated figures | 14/20 (70%) |
| Evidence completeness | 20/20 (100%) |

Four changes follow. Two are prompt text, one is prompt text plus a harness
correction, one is prompt text plus a schema change.

---

## (a) The agent may not state a risk band to the client

**Failure addressed:** `communicated_band` 11/20. Nine clients were told a risk
level that the policy did not compute.

**Evidence.** Tomasz refuses to answer anything, gives no usable reading, and
the profile correctly comes back `insufficient_data` with no band. He was still
told:

> *"That points toward a **higher risk band**."*

Ana was told *"A **low to moderate risk band**, focused on capital preservation"*
— band 2 — while the policy computed band 1. In both cases the stored profile is
correct and the conversation is not. This is the failure mode a profile
comparison can never catch, because the profile is right.

**Root cause.** v1 says: *"You output a risk band and eligible product
categories only."* Read as an instruction about the conversation, that sentence
invites the agent to tell the client their band. It was written to constrain
what the agent may name, and it licensed the thing it was meant to prevent.

**v1 text removed**

```
  - Never name or recommend a specific financial product or instrument. You
    output a risk band and eligible product categories only.
```

**v2 text added**

```
  - Never name or recommend a specific financial product or instrument.

  - Do not state or imply a risk band or risk level to the client. You elicit
    and record; you do not deliver the assessment. Do not tell the client they
    are cautious, conservative, moderate, balanced, growth-oriented, low or
    high risk, or any number on a scale. Do not describe what someone in their
    position should hold, and do not list the kinds of investment open to them.
    If they ask what their risk level is, say the assessment is produced after
    the conversation and will be shared with them then, and continue.

    This applies to your turns in the conversation only. In the JSON you
    produce afterwards, still give your honest proposed_risk_band — it is
    recorded and compared against the computed band, and it never reaches the
    client.
```

**Why the second paragraph exists.** Without it the instruction is ambiguous
between "do not say it to the client" and "do not produce it at all", and the
model has a live incentive to drop `proposed_risk_band` from the JSON.
Divergence between the model's proposal and the computed band is a reported
metric, so losing that field would destroy a measurement in the course of
fixing a different one.

**Risk introduced.** An agent forbidden to give any signal may become evasive
or unhelpfully terse at the close of the conversation. Watch the transcripts of
clients who ask directly.

---

## (b) Drawdown scenarios in percentages or the client's own figure

**Failure addressed:** `no_fabrication` 14/20. Six runs asserted a monetary
figure the client never gave, all in the same place: the drawdown scenario.

**Evidence.** Andrej, turn 4:

> *"imagine the value of your pot dropped by 15% over a few months — say, from
> €50,000 down to €42,500"*

He never stated a pot size. The same shape appears with €3,000→€2,100,
€5,000→€4,000, €100,000→€70,000, €12,000→€9,600.

**Root cause — and it was ours.** The *harness* protocol, appended to both
prompt versions, said:

```
- Do not finish before you have put a concrete drawdown scenario to the client
  and heard their answer
```

"Concrete" is satisfiable two ways: a real percentage, or a real amount. When
the client has not given an amount, the cheapest way to sound concrete is to
invent one. The harness instructed the behaviour it then scored as a failure.

**v2 text added**

```
  - When you put a drawdown scenario to the client, express the fall as a
    PERCENTAGE, or in an amount the client has already given you in their own
    words. Never invent a monetary figure to make a scenario feel concrete. If
    they have not given you an amount, "a fall of 15% over a few months" is a
    complete scenario and needs no euro sign. The same applies to every other
    number in the conversation: if the client did not say it, do not say it.
```

Also, the bullet in the field list changed from *"tested with a concrete
drawdown scenario"* to *"tested with a drawdown scenario"*.

**Harness correction.** The drawdown mandate was moved out of the shared
protocol in `src/lib/agent.ts` and into the two prompt files. It was never
mechanics — how to elicit a reading is policy — and leaving it in shared
mechanics meant a policy instruction was being applied to both arms while
claiming the arms differed only in policy.

**This is the one place where v1's composed prompt changed.** `intake_v1.txt`
now carries the original sentence *verbatim*, so v1's instruction content is
identical to what produced `results/v1.json`; only its position moved, from
after the protocol to inside the policy block. If v1 is ever re-run, that
ordering difference is the one thing that is not identical. It is recorded here
rather than discovered later.

---

## (c) Product categories derived in code, not chosen by the model

**Failure addressed:** `band_categories` 5/20. Fifteen runs offered at least
one category above the client's own computed band.

**Evidence.** `developed_market_equity` offered 11 times, `global_equity` 9,
`multi_asset_growth` 7 — at computed bands 1, 2, 3 and 4. Ana, at computed band
1, was offered government bonds, investment grade bonds and multi-asset
conservative, all of which require band 2.

**Root cause.** v1 hands the model a closed category vocabulary and never ties
it to the band. The list reads as "categories that exist" rather than
"categories this client may be offered". More fundamentally: choosing rows of a
table where `category_band <= computed_band` is arithmetic, and a language
model brings nothing to it.

**Change.** `eligible_product_categories` is removed from the v2 extraction
schema. The model does not emit it. `finaliseProfile` derives it from the
computed band using the `CATEGORY_BAND` table in CONTEXT.md. A null band
derives an empty list.

- `extractedProfileSchemaV2 = extractedProfileSchema.omit({ eligible_product_categories: true })`
  — derived from the v1 schema so the two cannot drift on any other field.
- The extraction instructions for v2 replace the category block with a note
  saying the field is not in the schema and there is nothing to decide.

**The criterion is kept, and now tests the derivation.** It is unfailable by
construction for v2, which is the point: it is a regression test asserting that
the derivation never contradicts the band, and it still catches the null-band
case. A test that cannot fail is worthless as evidence about the model and
valuable as a guard on the code — those are different jobs, and this is now
honestly the second one.

**Risk introduced.** v2's `band_categories` score is no longer evidence about
the agent. The v1-to-v2 delta on that row measures a code change, not a
behaviour change, and must be presented as such.

---

## (d) Contradiction pairs must name the two conflicting fields

**Failure addressed:** `contradictions` 14/20.

**Evidence.** Ana. The ground truth pair is
`horizon_years | stated_risk_tolerance`. v1 logged
`capacity_for_loss | stated_risk_tolerance`, and in an earlier run
`behavioural_loss_tolerance | stated_risk_tolerance` — while the accompanying
description said *"stated tolerance of 4 is credible in principle but not
credible given the 18-month constraint"*, which is the horizon conflict,
correctly reasoned and then filed under the wrong pair. The model understood
the contradiction and mislabelled it.

**Root cause.** v1 names the field vocabulary and never says the pair must be
the two things that actually conflict. Any two fields that came up while
thinking about the conflict satisfy the instruction as written.

**v2 text added**

```
  - When you record a contradiction, the two fields you name must be the two
    that actually conflict with each other — not two fields that merely came up
    in your reasoning about it. Ask which pair of readings cannot both be true.
    A client who is genuinely willing to hold through a fall but needs the money
    in eighteen months is a conflict between horizon_years and
    stated_risk_tolerance; their stated and behavioural answers agree with each
    other, so that is not the pair. Name the pair, then explain it.
```

**Risk introduced.** The worked example is Ana's case, and Ana is one of the
twenty scored personas. This is teaching to the test on one item. The honest
reading of any improvement on Ana specifically is that it may not generalise;
the other nineteen are the evidence that matters.

---

## Deliberately not changed

**`capacity_for_loss`, at 58% agreement (11/19).** The weakest reading in the
profile, wrong on eight personas, and left alone. v2 must be attributable to
four changes; adding a fifth would make every delta harder to read. It stays a
reported known weakness, and it is the obvious candidate for v3.

Seven v1 runs got the band right while a component under it was wrong. On a
larger sample that number is what says whether band accuracy is real or whether
the ceilings are doing the work.

---

## Not a prompt change: the judge span fix

Before v2 was written, a defect in the *harness* was corrected. The
communicated-band extraction asked the judge for a "verbatim sentence", and the
judge sometimes composed one that read correctly but was not a contiguous copy
of any turn. Verification failed, and two runs — Ivana and Bogdan — failed
closed for the harness's reason rather than the agent's. Both had in fact
communicated the correct band.

The judge is now given the assistant turns as an indexed list and must return a
turn index plus an exact contiguous substring of that turn. A span found in a
different assistant turn is accepted with the index reported as wrong; a span
found nowhere still fails closed.

Effect on the v1 baseline: unverified spans 2 → 0, `communicated_band` 8/20 →
11/20.

**Two caveats on that re-extraction, stated because they affect the baseline.**
Re-extracting re-runs all three model-graded judgements, so judge
nondeterminism moved two numbers that the span fix did not touch:
`no_fabrication` 12/20 → 14/20, and Ilona's communicated band changed from
"said band 1" to "no band communicated". One of the three
`communicated_band` improvements is therefore judge variance, not the fix. The
corrected baseline is the honest one to compare v2 against, but it is not a
noise-free measurement, and with n=20 neither arm should be read to the
percentage point.
