# Call Audit System v2 — Product Requirements

Oct 15, 2026 · @SS

## 1. Summary and current state

v2 splits every audit into a **system goal** (did the AI do its job?) and a **business goal** (did the call produce the outcome the agent exists for?), makes the scorecard fully configurable per agent, and adds a call-level and system-level dashboard. Everything is evaluated post-call from the recording and transcript we already store.

**What exists today (from the current build):**

- A call list of 4,543 calls (1,583 completed, 1,961 no answer) with filters for agent, status, direction, audit, pass/fail and goal.
- Only 32 calls are audited (average score 65). Audits run when someone clicks *Audit this call*.
- The auditor infers one goal per call, scores five fixed parameters (Opening, Communication, Troubleshooting, Query handling, Closure) at 20 points each, and fails any call with a failure condition (the score does not decide pass/fail; a failed call's score is capped at 40).
- Per-call page: summary, why it failed, scorecard, what went well, what to improve, conclusion, call details, recording and transcript. Auditor confidence is already reported.
- Header KPIs: success rate 87.5%, goal rate 44.4% (excluding not-applicable), needs review 0, plus a "most common failures" strip.

**Why v2 is needed, in one example:** call #4422 scored 40, failed on an *agent loop*, yet its goal is marked *achieved*. Today one goal flag cannot tell "the AI broke but the customer agreed anyway" from "the AI was perfect but the lead said no". The two-goal model separates exactly these cases.

## 2. Problem, goals and non-goals

**Problem.** A single inferred goal and a fixed five-parameter scorecard blur AI failures with business outcomes, cannot reflect what each agent is actually for, and miss the issues that make calls sound robotic (stalling phrases, repetition, interruptions, wrong language, bad number reading). With 0.7% of calls audited, one call at a time, there is also no reliable day-over-day picture.

**Goals**

1. Evaluate every connected call against a fixed **system goal** and an agent-specific **business goal**, reported separately.
2. Let admins define scorecard metrics, rubrics and weightage per agent, with versioning.
3. Keep auditing user-triggered, but make it scale: audit one call, a selection, or every call matching a filter (agent, date range, status, random sample), with the weights set by sliders before each run.
4. Ship a per-call audit view and a system dashboard with date-range trends, success/failure counts, goal rates and score histograms.
5. Make every verdict traceable to evidence (transcript turn, timestamp, rule).

**Non-goals for v2**

- Real-time (in-call) monitoring, and automatic auditing after every completed call; audits run only when a user starts them.
- Changing the voice agents themselves; v2 only measures them.
- Replacing human QA entirely; humans review low-confidence and disputed audits.

**Users**

| User | Needs |
| --- | --- |
| Ops / QA lead | Daily health, failure patterns, which calls to review |
| Agent builder (prompt / flow owner) | Which step or metric is breaking, before vs after a prompt change |
| Business owner / manager | Business goal rate, trend, whether failures are AI or market driven |
| Admin | Configure goals, metrics, weights, thresholds |

## 3. Dual goal model

Every connected call gets two independent verdicts. The **system goal** is the same for every agent and asks whether the AI did its job. The **business goal** is chosen per agent and asks whether the call produced the outcome the business wanted. Pass/fail and the quality score stay a third, separate axis.

&#91;embedded content: system goal × business goal · four outcome buckets\]

The bottom-left bucket is the engineering priority; the top-left bucket goes to the business team, not the prompt owner.

### 3.1 System goal (static, auto-evaluated)

The system goal is four checks. Each returns *Pass*, *Fail* or *N/A* with evidence; the system goal passes when every applicable check passes.

| Check | Passes when | How it is evaluated |
| --- | --- | --- |
| S1 Connected | Call was picked up and the agent spoke | Rule: status, picked-up time, at least one agent turn |
| S2 Conversation handled | Agent responded to every caller turn through the available duration; no loop, long dead air, or agent-side drop | Rule (silence gaps, ended-by) + LLM (loop / non-response detection) |
| S3 Flow completed where possible | Every required flow step was reached, or the call ended for a legitimate reason (caller hung up, not interested, wrong person) | LLM against the agent's flow definition, with an early-exit reason |
| S4 Data saved | Required call variables and disposition were captured and match what was said | Rule (fields present) + LLM (values consistent with transcript) |

Calls that were not answered (1,961 today, marked *Unjoined*) are not audited. They count toward a separate **connect rate**, so telephony problems are not mixed into AI quality.

### 3.2 Business goal (per agent, admin-defined)

An admin picks a business goal for each agent from a template library or writes a custom one.

| Field | Example (demo agent) |
| --- | --- |
| Name | Book a demo |
| Success criteria | Caller agreed to a demo with a confirmed date and time |
| Partial success (optional) | Caller asked for a callback or for details on WhatsApp |
| Not applicable when | Wrong number, caller is not the decision maker, call under 15 s |
| Required outputs | `demo_datetime`, `contact_channel` |
| Outcome values | Achieved · Partial · Not achieved · N/A |

Starter templates: book a demo, qualify a lead, confirm an appointment, collect a payment commitment, complete a survey, verify KYC details, resolve a support query.

When a business goal is *Not achieved*, the auditor also records a **reason** (not interested, price, timing, already using a competitor, needs approval, agent-caused). This turns a goal rate into an actionable breakdown and keeps agent-caused misses visible.

### 3.3 Rules that apply to both

- Goal definitions are **versioned**. Every audit stores the version it used, so historic numbers never shift silently.
- Goal rate = achieved ÷ (calls where the goal is applicable). N/A calls are excluded, as today. *Partial* does not count as achieved: the Partial share (partial ÷ applicable calls) is shown separately next to the goal rate.
- The auditor receives the agent's goal definitions and flow in its prompt; it no longer guesses the goal.

## 4. Configurable scorecard

A **scorecard** is a versioned list of metrics with weights that sum to 100%, attached to one or more agents. Admins can add, remove, reorder and re-weight metrics; the fixed 5 × 20 model becomes the first template. Before every audit, the user can also adjust each metric's weight with a slider; moving one slider automatically rebalances the others (section 4.4).

&#91;embedded content: mockup · weight sliders shown before auditing a call (10 default metrics, one locked)\]

### 4.1 What a metric is

| Field | Purpose |
| --- | --- |
| Name and description | Shown on the call page and dashboard |
| Rubric | What full, partial and zero marks look like, with one example each; this is what the LLM grades against |
| Method | LLM-judged, rule-based (count, regex, timing), audio-based, or hybrid |
| Weight (%) | Default share of the overall score, set with a slider; the total is always 100% because moving one slider rebalances the others |
| Scale | 0–10 by default, normalised to the weight |
| Applicability | When the metric is N/A (e.g. query handling when the caller asked nothing) |
| Auto-fail | If on, a zero on this metric fails the call regardless of total |
| Evidence required | The auditor must cite transcript turns or timestamps for any deduction |

### 4.2 Scoring

```latex
\text{Score} = 100 \cdot \frac{\sum_{i \in A} w_i \, s_i / m_i}{\sum_{i \in A} w_i}
```

Here A is the set of applicable metrics, w is the weight, s the metric score and m its maximum. N/A metrics drop out and the remaining weights are re-normalised, so a short call is not punished for questions nobody asked. A call **passes** when the score is at or above the scorecard's threshold (configurable, today 40), no auto-fail metric scored zero, and no Critical failure condition was flagged (section 4.5). Any one of these fails the call, so a clean call with no failure condition that scores under 40 fails. This replaces v1, where only failure conditions fail a call.

### 4.3 Proposed default metrics (from the review meeting)

| Metric | What it catches | Detection |
| --- | --- | --- |
| Flow adherence | Skipped steps, notes not followed, steps out of order | LLM compares the transcript with the agent's step list and returns which steps were reached |
| Query handling | Caller questions answered wrongly, vaguely or not at all; objections left unanswered | LLM against the knowledge base and rubric |
| Troubleshooting | Failure to diagnose and resolve a caller's problem: wrong steps, missing clarifying questions, no resolution or escalation | LLM against the agent's troubleshooting steps and rubric; N/A when the caller raised no problem |
| Communication & tone | Rude, flat or pushy tone; overly long turns | LLM |
| Opening & closure | Missing greeting, identity check, recap or next step | LLM |
| Language match | Agent not replying in the caller's chosen language, or switching unprompted | Language ID per turn (rule) + LLM for intent |
| Repetition | The same line or knowledge-base phrase said again and again | Similarity between agent turns (rule) + LLM to confirm it was not legitimate |
| Stalling & filler words | Stalling phrases (“Let me check”, “I will get back”) used repeatedly, and excess fillers (“umm”, “actually”, “basically”) beyond a normal rate | Phrase and word lists + count thresholds per 100 agent words (transcript only, no timing needed) |
| Interruptions / overlap | Agent speaking before the caller finished | Turn timestamps or diarised audio: overlap > 300 ms counted |
| Pronunciation & numbers | Mispronounced words; “200” read as “two zero zero”; numbers in the wrong language | Audio model on agent segments, plus a check of numbers in TTS text vs how they were spoken |

**Default weights:** every one of the 10 metrics starts at 10%, so the defaults total 100%. Users change them with the sliders (section 4.4). The review meeting's uneven weights (Flow adherence 12, Opening & closure 8, the slider mockup) are only a reference.

Stalling phrases and filler words were two metrics (5% each) in the review meeting. They are merged into one because both are caught the same way, with word lists and counts, and counting per word instead of per minute works without timestamps.

Interruptions / overlap and Pronunciation & numbers need audio or timestamps. Until those exist, they are treated as N/A on every call, so their weight is re-normalised away (section 4.2) instead of scoring 0.

Query handling and troubleshooting stay **separate metrics** with their own rubrics and weights. Query handling judges answers to questions; troubleshooting judges whether a problem was diagnosed and resolved. On calls where the caller raised no problem, troubleshooting is N/A and its weight is re-normalised away (section 4.2), so sales calls are not penalised.

### 4.4 Weight sliders and automatic rebalancing

Every metric has a slider. The sliders open pre-filled with the scorecard's default weights whenever a user starts an audit (one call, a selection, or a filtered batch), and the user can change them before pressing *Run audit*.

**Rebalancing rule**

1. The user moves metric *k* from its old weight to a new weight; the difference is *d*.
2. Every other **unlocked** metric absorbs *d* in proportion to its current weight: a metric holding 10 of the 80 unlocked points absorbs 10/80 of the change.
3. Locked metrics never move. The moved slider's maximum is 100 minus the locked total.
4. No weight goes below 0. If a metric hits 0, the rest of the change is spread over the remaining unlocked metrics.
5. Values are shown to one decimal; rounding is resolved so the total is exactly 100.0. Leftover tenths go to the largest rounding remainders; ties go to the metric listed first in the scorecard.

| Example: Flow adherence 10 → 18, Language match locked | Before | After |
| --- | --- | --- |
| Flow adherence (moved) | 10 | 18.0 |
| Language match (locked) | 10 | 10.0 |
| Every other metric (8 of them, each) | 10 | 9.0 |
| Total | 100 | 100.0 |

The eight unlocked metrics hold 80 points and absorb the +8 equally, 1 point each.

| Example with rounding: Flow adherence 10 → 20, Language match locked | Before | After |
| --- | --- | --- |
| Flow adherence (moved) | 10 | 20.0 |
| Language match (locked) | 10 | 10.0 |
| Query handling, Troubleshooting, Communication & tone, Opening & closure (each) | 10 | 8.8 |
| Repetition, Stalling & filler words, Interruptions, Pronunciation & numbers (each) | 10 | 8.7 |
| Total | 100 | 100.0 |

Each of the eight comes out at 8.75. Shown to one decimal that would be 8.7 each (total 99.6), so the 0.4 left over goes 0.1 at a time to the first four metrics in the list.

**Behaviour rules**

- Changes apply **to this audit or batch only**. *Reset to defaults* restores the scorecard weights; *Save as default* creates a new scorecard version. v2 has one shared admin login and no roles (section 7), so anyone signed in can do this.
- A weight of 0 excludes the metric from this audit, and the judge skips it, which also saves cost.
- Every audit stores the exact weights it used (`weights_used`), shown on the call page next to the score.
- Weights only affect the scoring step, not the judge. Because raw metric scores are stored, a user can **re-score** an audited call with new slider values instantly, with no new LLM call.

### 4.5 Failure conditions

Failure conditions are named, yes/no events the judge flags on a call, separate from the weighted metrics. A metric measures *how well* something was done; a failure condition records that something *must not happen* did happen. They drive the "why this call failed" box, the *Top failure causes* chart and the failure filter on the call list.

Each condition has a code, label, definition, **severity** and the system check or metric it rolls up to. Severity is set per scorecard:

- **Critical:** the call fails regardless of score.
- **Major:** the linked metric is set to 0 for this call.
- **Minor:** flagged and counted, with no score impact.

Every definition states what does *not* count, as the existing loop definition does (re-asking after a garbled or missing reply is not a loop). That clause is what keeps false positives down.

**Already implemented**

| Code | Label | Flags when | Default severity | Rolls up to |
| --- | --- | --- | --- | --- |
| `CRITICAL_HALLUCINATION` | Stated false facts | A material fact (price, policy, date, service, product, job detail) contradicts or is unsupported by the instructions; without full instructions, only facts contradicting call variables | Critical | Query handling; knowledge grounding |
| `IGNORED_STOP_REQUEST` | Ignored a request to stop or for a human | Caller asked to end the call, not be called again, or speak to a human, and the agent kept going | Critical | S2 Conversation handled |
| `UNAUTHORIZED_PROMISE` | Made a promise it cannot make | Promised discounts, guarantees, selection or outcomes beyond its authority | Critical | Query handling |
| `UNPROFESSIONAL_CONDUCT` | Rude or unprofessional | Rude, dismissive, argumentative or inappropriate language | Critical | Communication & tone |
| `AGENT_LOOP` (code is `"S"` in the current file) | Stuck in a loop | Same question or statement 3+ times after a clear answer, without progress; not a loop when re-asking after a missing or unclear reply | Major | S2 Conversation handled; Repetition |
| `CALL_ERROR` (rule) | Call ended on a technical error | The call ended with `connection_error` or `system_error` | Critical | S2 Conversation handled |
| `NO_AGENT_SPEECH` (rule) | Agent never spoke | Call connected but no agent turn in the transcript | Critical | S1 Connected |
| `DISCRIMINATORY_QUESTION` (Hansa) | Asked a discriminatory question | Asked about age, religion, caste, marital status, pregnancy or family planning, or disability, unless the instructions require it for the role | Critical | Communication & tone; compliance |
| `OUTCOME_MISMATCH` (Hansa) | Recorded data contradicts the call | A value in the saved outcome clearly contradicts what was said and confirmed (e.g. notice period saved as 30 days, candidate said 90); only judged when an outcome was saved | Critical | S4 Data saved |

These are the seeded severities for the first scorecard template.

The loop condition's code is currently `"S"`, which looks like a truncated value. Renaming it to `AGENT_LOOP` (with a migration for stored audits) keeps filters and exports readable.

**Proposed additions**

| Code | Label | Flags when (and what does not count) | Default severity | Rolls up to |
| --- | --- | --- | --- | --- |
| `UNRESPONSIVE_AGENT` | Went silent | No agent reply for more than 8 s after a caller turn, or the agent stopped responding; not when the caller is still speaking or on hold by request | Critical | S2 Conversation handled |
| `PREMATURE_HANGUP` | Ended the call too early | Agent ended the call while the caller was mid-question or before a required closing step; not when the caller said goodbye | Major | S3 Flow completed |
| `WRONG_LANGUAGE` | Ignored the caller's language | Kept replying in another language after the caller switched or asked; not for single borrowed words (e.g. English terms in Hindi speech) | Major | Language match |
| `CONTINUED_AFTER_WRONG_PERSON` | Pitched to the wrong person | Caller said wrong number or not the named person, and the agent continued the pitch | Major | Flow adherence |
| `PUSHY_AFTER_DECLINE` | Pressured after a clear no | Pushed the offer 2+ more times after a clear "not interested"; one polite attempt to address an objection is fine | Major | Communication & tone |
| `DENIED_BEING_AI` | Claimed to be human | Said it was a human when sincerely asked whether it is an AI or a bot | Critical | Communication & tone; compliance |
| `SENSITIVE_DATA_EXPOSED` | Disclosed sensitive data | Read out personal, account or internal information before identity was confirmed, or shared another customer's data | Critical | Compliance |
| `FALSE_ACTION_CLAIM` | Claimed an action that did not happen | Said a booking, message or callback was done when the tool call failed or was never made; needs tool-call logs | Critical | S4 Data saved |
| `OUTCOME_MISRECORDED` | Saved the wrong outcome | Saved disposition or variables contradict the transcript (e.g. demo saved as booked after the caller declined) | Critical | S4 Data saved |
| `SKIPPED_REQUIRED_STEP` | Skipped a mandatory step | A step marked *required* in the flow (consent, identity check, disclosure) never happened; optional steps go to Flow adherence instead | Major | S3 Flow completed; Flow adherence |
| `OFF_SCOPE_ADVICE` | Gave advice outside its role | Gave legal, medical, financial or other advice its instructions do not allow | Major | Query handling |

**Behaviour rules**

- Conditions are a shared library; each scorecard enables the ones it needs and sets their severity.
- The judge must cite turns and a timestamp for every flagged condition; a flag without evidence is dropped.
- Calls can be filtered by condition code on the call list, and every bar in *Top failure causes* opens those calls.
- New conditions start as *Minor* for one week (flag only) to check their false-positive rate before they affect scores.

## 5. Per-call audit view (Phase 2)

The call page leads with four verdict tiles (score, system goal, business goal, confidence), then shows why: which system check failed, which metrics lost points, and evidence that jumps to the exact moment in the recording.

&#91;embedded content: mockup · call #4422 re-imagined under v2 (illustrative values)\]

**Changes from today's call page**

1. **Verdict tiles** replace the single score block: score + pass/fail, system goal, business goal (with the extracted outcome, e.g. demo time), auditor confidence.
2. **System goal checks** S1–S4, each with a one-line reason.
3. **Scorecard sorted lowest first**, each metric expandable to its rubric, score reason and evidence.
4. **Call timeline** over the recording with markers for stalls, interruptions, loops, dead air and language switches; clicking a marker seeks the audio and scrolls the transcript.
5. **Evidence links**: every deduction cites turn numbers and a timestamp. Deductions without evidence are not allowed.
6. **Transcript annotations**: flagged turns are highlighted inline with the metric name.
7. **Human review actions**: agree, dispute a metric (with a corrected score and note), flag for review. Disputes feed calibration (section 8). With one shared admin login, the reviewer is recorded as that login, not as a person.
8. **Audit history**: re-audits and re-scores keep previous versions, with the scorecard version, goal version and exact weights used.
9. **Unaudited calls** show an *Audit now* button, as today. It opens the weight sliders (section 4.4) before the audit runs.

## 6. System dashboard (Phase 2)

A single dashboard answers “are calls getting better, and if not, why?” for any date range, agent or scorecard version, with every number clickable through to the calls behind it.

&#91;embedded content: mockup · system dashboard, last 7 days (illustrative numbers)\]

**Components**

1. **Filters:** date range (today, last 7 / 30 days, custom), agent, direction, business goal, scorecard version, and a *compare to previous period* toggle that adds deltas everywhere.
2. **KPI tiles with deltas:** total calls, connect rate, connected calls, audit coverage, pass rate, system goal rate, business goal rate (with the Partial share shown next to it), average score, needs-review count.
3. **Day-over-day trend:** pass rate, system goal rate and business goal rate per day (or week), with **release markers** for prompt, flow, voice or scorecard changes so improvements can be tied to a change.
4. **Score histogram:** bins 0–20, 20–40, 40–60, 60–80, 80–100 as agreed in the meeting, with the bins under the pass threshold highlighted. Optional overlay of the comparison period.
5. **Top failure causes:** failed system checks and lowest-scoring metrics ranked by number of calls affected, replacing today's “most common failures” strip.
6. **Outcome buckets:** counts for the four system × business buckets from section 3.
7. **Metric heatmap** (agents × metrics, average % score) to spot which agent is weak on which metric.
8. **Business goal funnel** per agent: connected → conversation completed → goal discussed → goal achieved, with the not-achieved reasons as a breakdown.
9. **Agent comparison table:** calls, pass rate, goal rates, average score and trend per agent.

**Behaviour rules**

- All rates show their denominator on hover (e.g. 412 of 1,006 applicable calls).
- Metric trends are only compared within the same scorecard version; a version change draws a marker and breaks the line.
- Times are shown in the user's time zone (IST by default); daily buckets use the same zone.
- Because audits are user-triggered, every number shows how many audited calls back it, and a warning appears when fewer than 30 calls do, or when the audited calls were hand-picked rather than a random sample.
- Calls audited with different slider weights are not directly comparable. A toggle switches averages between *as audited* and *re-scored with one weight set* (from the stored raw metric scores).

## 7. Evaluation pipeline and data model

Deterministic signals (timing, overlap, language, counts) are computed in code first and passed to the LLM, so the model judges meaning while code owns everything measurable. Code, not the LLM, computes the final score.

&#91;embedded content: audit pipeline · 8 steps, runs only when a user starts an audit\]

**Pipeline notes**

- **Trigger (user-initiated only):** no audit runs on its own. A user starts one from a call page (*Audit this call*), from a multi-select in the call list (*Audit selected*), or from the current filters (*Audit all matching*, with an optional *random sample of N*). Each run shows the call count and estimated cost, then the weight sliders, before it starts. Bulk runs execute as a background job with progress and can be cancelled.
- **Structured output:** the judge returns JSON per check and metric (`result`, `score`, `reason`, `evidence[{turns, ts_start, ts_end}]`, `confidence`). Invalid JSON or evidence pointing at non-existent turns triggers one retry, then *needs review*.
- **Cost control:** one judge call per audit with all metrics batched; metrics set to weight 0 are skipped; audio-model metrics (pronunciation) run only on agent segments.
- **Re-score vs re-audit:** changing only weights re-scores from stored metric scores (no LLM call). A re-audit (new judge run) is needed only when goals, rubrics or metrics change; it creates a new row and marks the old one superseded.
- **Sign-in:** one shared admin login (username and password) with no roles; everyone signed in can do everything, including publishing. `triggered_by` and reviewer fields record that login, so they can't tell people apart. Per-user accounts and roles are out of scope for v2.

**Core entities**

| Entity | Key fields |
| --- | --- |
| `goal_config` (versioned) | agent\_id, version, system check settings (silence limit, required variables, flow steps), business goal fields from §3.2 |
| `scorecard` (versioned) | id, version, agents\[\], pass\_threshold, status (draft / published) |
| `metric` | scorecard\_version, name, rubric, method, weight, scale, auto\_fail, applicability, params (phrase list, count bands, overlap ms) |
| `audit` | call\_id, triggered\_by, batch\_id, goal\_version, scorecard\_version, weights\_used (slider values at run time), score, passed, system\_goal, business\_goal, business\_reason, confidence, judge model and prompt version, cost, status |
| `audit_check` | audit\_id, check (S1–S4), result, reason, evidence |
| `metric_result` | audit\_id, metric\_id, score, max, n\_a, reason, evidence |
| `review` | audit\_id, reviewer, verdict (agree / dispute), corrected scores, note |
| `release_marker` | agent\_id, type (prompt, flow, voice, scorecard), version, date, note |
| `daily_rollup` | date, agent\_id, counts and rates by goal, pass, bucket, histogram bins, per-metric averages |

Dashboards read from `daily_rollup` (refreshed on every audit write and nightly), so a 30-day view stays fast as call volume grows.

## 8. Recommended additions beyond the meeting

The three highest-value additions are bulk and filter-based auditing, a human-labelled calibration set that keeps the LLM judge honest, and release markers that tie score changes to prompt changes. The rest are ranked below.

| # | Feature | Why it matters | Phase |
| --- | --- | --- | --- |
| 1 | Bulk and filter-based auditing | Coverage is 32 of 4,543 calls today. Auditing an agent's week or a random sample in one action gives trends enough calls, while the team still decides what gets audited | 1 |
| 2 | Calibration (golden) set | 50–100 calls scored by humans; judge agreement per metric is measured on every scorecard or prompt change, and publishing is blocked if it drops | 1 |
| 3 | Scorecard simulation | Before publishing new weights, re-score the last N audits from stored metric scores (no new LLM cost) and show how pass rate would move | 1 |
| 4 | Response latency metric | Time from caller finishing to agent speaking (p50 / p95) is one of the biggest drivers of a voice agent feeling robotic | 2 |
| 5 | Dead air and talk ratio | Long silences and agent talk share above \~70% flag monologues and stuck turns | 2 |
| 6 | Knowledge grounding check | Flags claims or promises (pricing, features, timelines) not supported by the agent's knowledge base | 2 |
| 7 | Human review queue | Low confidence, disputes, AI-failure bucket and a random 5% sample, with SLA and reviewer agreement stats | 2 |
| 8 | Release markers and before/after | Log prompt, flow, voice and scorecard versions; compare any two periods or versions side by side | 2 |
| 9 | Alerts and daily digest | Slack or email when pass rate or a goal rate drops by more than a set number of points, or a failure cause spikes | 3 |
| 10 | Caller insights | Sentiment at start vs end, objections, competitor mentions, top questions the agent could not answer (feeds the KB) | 3 |
| 11 | Weekly “top fixes” report | LLM summary of the 3 most common failure patterns, with example calls and a suggested prompt change | 3 |
| 12 | Transcript quality guard | If ASR confidence is low, mark the audit low-confidence instead of penalising the agent for words it never said | 2 |
| 13 | PII redaction and compliance checks | Mask phone, card and ID numbers before sending to the LLM; optional checks for required disclosures and consent | 2 |
| 14 | Config change log | What changed in which goal, metric or weight, and when. v2 has one shared admin login and no roles, so the log can't name the person; per-user accounts and roles come later | 1 |
| 15 | Export and webhooks | CSV export of any filtered list; push business outcome and extracted fields (e.g. demo time) to the CRM | 3 |
| 16 | Cost per audit | Track tokens and audio-model cost per audit and per day, to tune sampling | 2 |

## 9. Rollout, success metrics, risks and open questions

Build in four phases: foundations, then goals and the configurable scorecard (the meeting's core ask), then the call view and dashboard, then advanced audio signals. These are numbered P0–P3 (P0 foundations, P1 goals and scorecard, P2 call view and dashboard, P3 audio); the "Phase" labels in sections 5, 6 and 8 use the same numbers. The new scores replace the old ones only after the judge matches human QA on a labelled set.

&#91;embedded content: roadmap · 4 phases, 2 gates · durations are estimates, not commitments\]

During Phase 1, run v1 and v2 audits side by side on the same calls for a week, so the jump in numbers can be explained before anyone sees the new dashboard.

### Success metrics

| Metric | Today | Target |
| --- | --- | --- |
| Audit coverage of connected calls | 32 of 4,543 calls (0.7%) | At least 30 audited calls per agent per week reviewed (random sample) |
| Judge agreement with human QA (per metric, golden set) | Not measured | ≥ 85% within one scale point |
| Disputed audits | Not tracked | < 5% of reviewed audits |
| Time to find the cause of a pass-rate drop | Manual, call by call | < 10 min from the dashboard |
| Audit cost per call | Not tracked | Agreed budget, tracked daily |

### Risks

| Risk | Mitigation |
| --- | --- |
| LLM judge inconsistency or bias | Rubrics with examples, structured output, golden-set gate, temperature 0, pinned model version |
| ASR errors counted as agent errors | Transcript quality guard; pronunciation judged from audio, not transcript |
| Overlap detection needs reliable per-speaker timestamps | Check whether the provider gives word-level timestamps per channel; if not, use stereo recordings or a diarisation step |
| Audited calls are not representative, because people pick them | *Random sample of N* option in bulk audits; dashboard shows sample size and warns on hand-picked or small samples |
| Per-audit slider changes make scores across calls incomparable | Store `weights_used` per audit; dashboard toggle to re-score everything with one weight set |
| Weight changes to defaults make history incomparable | Versioning, trend breaks at version changes, simulation before saving new defaults |
| Too many metrics dilute the score | Cap at \~12 metrics per scorecard; auto-fail for the truly critical ones |
| Cost of large bulk audits | Show call count and estimated cost before a run, skip weight-0 metrics, skip calls under a minimum duration |

### Open questions

- [ ] Final metric list and default weights per agent type (section 4.3 is a proposal).
- [ ] Does \*Save as default\* from the sliders need approval before it becomes a new scorecard version? (Who may use it is decided: v2 has one shared admin login, so anyone signed in.)
- [ ] Default pass threshold: keep 40 or raise it once the new metrics are calibrated?
- [ ] Does the telephony provider (Plivo) give per-channel recordings or word timestamps needed for overlap and latency?
- [ ] Who owns the golden set and how many calls per agent?
- [x] Should *Partial* business outcomes count toward the goal rate, or be reported separately? Decided 2026-10-22: reported separately (section 3.3).
- [ ] Is S4 (data saved) checked against our database, or only against variables in the call record?
