# Brahmaverse auditing service

Automatically audits every finished AI voice call (Hansa, Varuna, Vajra, …) and shows the results
on a dashboard: a score out of 100, whether the call passed, whether it achieved its goal, what went
well, what went wrong, and evidence for each point.

```
call ends → voice_call_logs row (integration-service)
          → picked up by the sync job (polls the table, read-only) or the voicecall.ended event
          → audit worker: rule checks + LLM judge (transcript + agent's prompt + goal config)
          → saves an audit_results row → dashboard reads it
```

It is its own service with its own database. It only ever reads other services' data.

## Agents

`agent_code` is empty on most call rows (inbound calls and older outbound calls have no queued
payload), so agents are matched on `agent_id` too (`src/audit/rubrics/index.ts`):

| agent_id | Agent | Rubric |
|---|---|---|
| 1 | Hansa (HR) | `hansa-v2` |
| 4 | Project manager | `default-v2` |
| 9 | Caller | `default-v2` |

## What each call gets

| Field | Meaning |
|---|---|
| `overall_score` | 0–100: scorecard points over points available (applicable categories only), capped at 40 if the call failed. `null` if nothing could be scored. |
| `call_success` | `PASS`, or `FAIL` with the reason codes that triggered it. One failure condition is enough to fail. |
| `call_goal` | `ACHIEVED` / `NOT_ACHIEVED` / `NOT_APPLICABLE`, with a reason code. Not-applicable calls are left out of the goal rate. |
| `metrics` | The scorecard: **Opening, Communication, Troubleshooting, Query handling, Closure**, 20 points each. The judge scores each 0–10 against written anchors (×2 = points), with reasoning and transcript quotes. A category the call never needed (nothing to troubleshoot, no question asked) is **N/A** and left out of the total rather than scored 0. |
| `call_summary` | What happened on the call, in a few sentences. |
| `went_well` | What the agent did well, each tied to a transcript turn. |
| `improvements` | What can be improved, each with a concrete suggestion of what to do instead. |
| `conclusion` | The auditor's overall judgement of the call. |
| `sentiment` | The other party's mood at the start and end. |
| `auditor_confidence` | How far to trust this audit. Below `AUDIT_REVIEW_THRESHOLD`, the call is flagged for human review. |
| `rubric_version` | Which rubric produced the score. Bump it when the rubric changes so old and new scores aren't mixed. |
| `engine` (column) | `v1` (this audit) or `v2` (see "v2 audits"). The current API and dashboard only read `v1` rows, so a v2 audit never changes them. |

Every quote the judge cites is checked against the transcript. Quotes that aren't found are marked
in the result and lower the confidence.

## Layout

```
src/audit/            the auditor (no I/O except the judge call)
  rubrics/            per-agent rubric: goal, failure conditions, dimensions (hansa.ts, default.ts)
  rules.ts            checks that need no LLM: technical errors, agent silent, agent looping
  judge/              prompt, strict JSON schema, OpenAI client
  evidence.ts         verifies every quote against the transcript
  score.ts            weighted score, fail cap, auditor confidence
  audit-call.ts       rules + judge → result
  run-audit.ts        fetches the agent prompt, runs the audit, saves it (idempotent per call + rubric version)
src/db/               audit_results model; migrations/ holds the numbered up/down schema changes
src/background/       voicecall.ended subscriber
src/routes/           dashboard API (/v1/audit/...)
src/scripts/          replay (audit past calls), eval-planted / eval-v2 (test the judge)
fixtures/planted/     synthetic calls (Hansa, one Caller), each with one planted defect
fixtures/reviews/     recorded golden-set review rows, for the eval-v2 tests
docs/evals/           saved eval-v2 reports (ids and numbers only)
fixtures/judge/       recorded judge outputs on planted calls, replayed in tests by fixtureJudge(name)
patches/              changes the other services need (see below)
dashboard/            Vite + React dashboard (call list, call detail)
```

## Setup

```bash
cp .env.example .env            # fill in DB_PASSWORD, MESSAGE_BUS_PASSWORD, OPENAI_API_KEY, AUDIT_ADMIN_PASSWORD
export NPM_TOKEN=<GitHub PAT with read:packages>   # for @fastor7/message-bus
bun install
bun run migrate                 # creates the database, then applies pending migrations (src/db/migrations/)
                                # `bun run migrate:down` reverts the last one; the API won't start while any are pending
bun run dev                     # API on :8095 (AUDIT_SUBSCRIBE=true also audits every voicecall.ended; off by default)

cd dashboard && cp .env.example .env && npm install && npm run dev   # dashboard on :5175
```

Sign in to the dashboard with `AUDIT_ADMIN_USERNAME` / `AUDIT_ADMIN_PASSWORD` (default `admin` / `password`, for local
dev only: the API refuses the default password when `NODE_ENV=production` and warns otherwise). A sign-in lasts
`AUDIT_SESSION_HOURS` (12). Every `/v1/audit/*` route except `health` and `auth/login` needs the session token as
`Authorization: Bearer <token>`; get one from `POST /v1/audit/auth/login` with `{ "username", "password" }`.
Audits, re-scores and published conditions record the signed-in username (`triggered_by` / `created_by`). After 10
failed sign-ins from one address in 15 minutes, that address gets 429 until the window ends.

v2 (`docs/prd-v2.md`) is off until `AUDIT_V2_ENABLED=true`. While it is off, every existing route returns
exactly what it did before v2. The dashboard reads the flag from `GET /v1/audit/config` (`{ "data": { "v2_enabled": false } }`).
With the flag on, the dashboard's *Failure conditions* page lists the v2 condition library and adds new conditions
(label, definition, what does not count, severity) to scorecard drafts; they apply once the draft is published.

### v2 audits

With the flag on, `POST /v1/audit/v2/calls/:id/audit` (optional body `{ "weights": { "<metric>": 10, … } }`, total 100;
default: the scorecard's) audits one call with the v2 engine. `bun run replay --db --call-id 4422 --engine v2 --print`
does the same from the command line and prints the judge's raw JSON. v1 audits keep working side by side.

- **Config:** the agent's published scorecard (10 metrics) and goal config. Needs `AUDIT_V2_JUDGE_MODEL`, a dated
  model id (`gpt-5.4-mini-2026-03-17`, chosen by benchmark on 2026-10-28: `bun run bench:judge`); aliases are refused.
- **Judge input:** turn-numbered transcript, call variables, the agent's instructions (ai-service `prompts`) and flow
  (Vajra workflow, else the prompt text), the business goal, the metrics the judge scores, the enabled conditions, and
  the measured facts (S1, S2 rule parts, S4 fields, repetition, stalling and filler words, language per turn), which it
  must not contradict. Weight-0 metrics are not sent.
- **Judge output:** strict JSON: S2–S4, business goal (outcome, reason code, required outputs), one entry per metric
  (score, n/a, reason, evidence), flagged conditions, confidence, summary. An answer that isn't valid JSON, cites a
  turn the call doesn't have, or deducts points without evidence is retried once; after a second bad answer the audit
  is kept with `needs_review` (a parseable answer is used without the bad evidence; otherwise only the rule parts).
- **Result:** code computes the score (`computeScore`: weights, N/A re-normalised, Major zeroes its metric, Critical
  fails the call, under the threshold fails). A check fails if its rule part or the judge's part fails, so a loop the
  rule measured fails S2 even if the judge disagrees; a Critical or Major flag also fails the check it rolls up to
  (e.g. `IGNORED_STOP_REQUEST` → S2). Stalling & filler words is scored by code; interruptions and
  pronunciation are N/A until timing and audio exist.
- **Storage:** `audit_results` rows with `engine = 'v2'`, plus `audit_check`, `metric_result` and `failure_flag`.
  Every audit inserts a new row; when it completes, the call's previous v2 row gets `superseded_by`. A judge error
  marks only the new row `failed`. Unless forced, a call already audited with the same scorecard, goal, weights,
  prompt version and model returns the existing audit. Each row stores the model and `judge_prompt_version`.

## Changes needed in the other services

These live in `patches/` and are **not applied**. Apply them on a branch in each repo:

```bash
cd ../brahmaverse-integration-service && git checkout -b feat/voicecall-ended-event
git apply ../Brahmaverse-auditing-service/patches/integration-service-voicecall-ended.patch

cd ../brahmaverse-ai-service && git checkout -b feat/audit-prompt-rpc
git apply ../Brahmaverse-auditing-service/patches/ai-service-prompt-rpc.patch
```

| Patch | What it adds | Without it |
|---|---|---|
| integration-service | Publishes `voicecall.ended` from `finalizeCallEnd` (fire-and-forget, never blocks quota or callbacks), plus `query.voicecall.recording-url`. Unit tests included. | Calls arrive through the sync job instead (up to one interval later). Recordings still play when `AWS_*` is set. |
| ai-service | `query.realtime-call.prompt`: the agent's system prompt rendered with the call's variables. | Calls are graded without the agent's instructions. The judge then only flags facts that contradict the call variables, so some invented facts get through, and confidence drops by 0.05. |

## Testing

```bash
bun test                        # unit tests: rules, evidence checks, scoring, result shape (stub or recorded judge)
bun run test:db                 # migrations up -> down -> up, a snapshot of every v1 GET route (flag off), and v1 routes
                                # ignoring v2 rows, on a throwaway database
                                # (created and dropped on the DB_* server)
bun run eval:planted            # real v1 judge on the 10 v1 planted-defect Hansa calls; exits 1 on any miss
bun run eval:v2                 # real v2 judge on all planted cases + the golden set; report in docs/evals/; exits 1 on a planted miss
bun run eval:v2 --compare v2-1  # also exits 1 if a planted case broke or any agreement number dropped vs that saved report
bun run record:fixture --case wrong-salary   # real judge on one planted case -> fixtures/judge/hansa-wrong-salary.json
bun run record:fixture --engine v2 --case agent-loop   # v2 judge (hansa v4) -> fixtures/judge/v2/hansa-agent-loop.json
bun run bench:judge --model <id> --model <id> [--runs 2] [--call-id 4422]   # compare judge models on v2; eval-output/bench-v2/
```

v2 fixtures live in `fixtures/judge/v2/`; `v2-*` ones are hand-edited copies of a recording (malformed JSON, a
missing turn, a deduction without evidence) for the retry tests, and say so in `note`. Re-record the v2 fixtures
after changing the v2 judge prompt (bump `JUDGE_PROMPT_VERSION`) or `AUDIT_V2_JUDGE_MODEL`.

Tests never call OpenAI: `src/test-preload.ts` (loaded by `bunfig.toml`) makes creating the OpenAI client throw
under `bun test`. Use `fixtureJudge(name)` to replay a recorded judge output instead. `record:fixture` is manual
(one OpenAI call) and takes planted cases only, so fixtures never hold a real call. It exits 1 and says so if the
recording misses its case's expectations; re-record it after changing the rubric, judge prompt or model.

`eval:planted` needs only `OPENAI_API_KEY`, with no database or bus. Re-run it before changing the
rubric, the judge prompt or the model. Full judge output is written to `eval-output/`.

### v2 agreement eval (`eval:v2`)

`bun run eval:v2` audits the planted cases (every enabled text-detectable failure condition has one) and the
**golden set** with the current v2 judge, then reports agreement with the reviewers. It needs the audit DB,
`SOURCE_DB_*` (golden calls' transcripts), `OPENAI_API_KEY` and `AUDIT_V2_JUDGE_MODEL`; `--only-planted` skips the
golden set.

- **Golden set:** per call, the latest agree / dispute review of a v2 audit with `review.in_golden_set = true`
  (migration 0013). A `normal` review's answer is the reviewed audit's values with its corrections
  (`expected_pass_fail`, `expected_business_outcome`, `expected_failure_codes`, `corrected_scores` by metric key,
  `corrected_checks`); a `blind` spot-check's answer is only what the reviewer entered (pass/fail, business outcome,
  failure codes).
- **Numbers:** per metric agreement within one scale point (both N/A agrees), per system check, pass/fail and
  business outcome (exact), failure codes (same set per call), precision and recall per failure code; the same for
  blind spot-checks only; the step 16 gate (at least 30 blind checks, 85% on pass/fail, business outcome and failure
  codes, no Critical code under 90% precision); the 5 calls with the biggest disagreements.
- **Report:** `docs/evals/<date>-<judge prompt version>.md` holds ids, codes and numbers only (a same-day re-run
  overwrites it). Judge reasons and reviewer notes for the biggest disagreements are printed, never saved.
- **Cache:** judge answers are kept in `eval-output/judge-cache/<judge prompt version>/` per call and exact request, so
  re-running unchanged calls makes no OpenAI calls; a changed rubric, reader output or model re-runs that call.
- **`--compare <version | report path>`** measures the new run and the saved one on the golden calls they share. Keep a
  rubric or judge-prompt change only if it passes.
- **Before publishing a scorecard or goal change:** run `bun run eval:v2` once on the published config (the baseline),
  make the draft, then `bun run eval:v2 --draft --compare <version>`. `--draft` grades with each agent's scorecard draft
  (the one publishing would move it to) and goal draft, and saves to `<date>-<version>-draft.md`, never over the
  baseline. Publish only if it passes. Real audits never use drafts. Nothing blocks *Publish* itself (decided
  2026-10-29: the golden set is empty until reviews exist; revisit after step 16).
- **Cap:** past 150 golden rows the report lists the oldest plain agrees to retire (`in_golden_set = false`); blind
  rows and disputes are never offered.

## Dashboard

The call list shows **every call in `voice_call_logs`** (any status, audited or not), read live from
the source table, with each call's latest audit alongside. Filter by agent, call status, direction,
audit state, pass/fail and goal; search by call id, contact name or summary; sort by date or score.
A call's page shows the full call record (timings, provider, error detail, variables, outcome,
metadata, recording, transcript) and, when audited, the audit. "Audit this call" grades a completed
call on demand.

## How Pass/Fail is decided

A call **fails if any single failure condition occurs**, and passes otherwise. Pass/Fail is not
derived from the score.

- **Rule checks** (deterministic): `CALL_ERROR` (ended with `connection_error` / `system_error`),
  `NO_AGENT_SPEECH`, `AGENT_LOOP` (the same line of 15+ characters said 3+ times; every repetition is cited).
- **Judge checks** (must cite every turn involved): `CRITICAL_HALLUCINATION`, `IGNORED_STOP_REQUEST`,
  `UNAUTHORIZED_PROMISE`, `UNPROFESSIONAL_CONDUCT`, `AGENT_LOOP`, plus `DISCRIMINATORY_QUESTION` and
  `OUTCOME_MISMATCH` for Hansa.

A failed call's overall score is capped at 40. A passing call can still score low; the score
measures how well the call was handled, and Pass/Fail measures whether anything unacceptable happened.

## Getting calls in

**Straight from `voice_call_logs` (recommended).** Set `SOURCE_DB_*` in `.env` to a login with read
access to `brainey-integration`. The service only runs SELECTs, and never selects phone numbers,
tokens or join URLs.

```bash
bun run replay --db --call-id 3507                    # one call
bun run replay --db --agent-id 9 --limit 20           # the 20 most recent Caller calls
bun run replay --db --agent-id 1 --from 2026-09-01 --to 2026-10-01 --limit 50
bun run replay --db --call-id 3507 --force            # re-grade a call already audited
```

**Automatically.** Set `AUDIT_SYNC_ENABLED=true`. Every `AUDIT_SYNC_INTERVAL_MINUTES` the service
audits calls for `AUDIT_SYNC_AGENT_IDS` that ended within `AUDIT_SYNC_LOOKBACK_HOURS` and haven't been
audited yet, at most `AUDIT_SYNC_MAX_PER_RUN` per run. Each audit is one OpenAI call, so start with
one agent.

**Other sources:** `--file calls.json` (a JSON array of rows) or `--rpc` (integration-service's
`query.voicecall.list`). With `AUDIT_SUBSCRIBE=true` (off by default) and the integration-service patch
applied, the `voicecall.ended` event audits calls the moment they end.

**Recordings** play in the dashboard when `AWS_*` is set: the service presigns the private-bucket URL
itself (serving it as `audio/wav`, since archived files were stored with the wrong content type).

## Known limits

- **Prompt versions aren't pinned per call.** ai-service edits prompt rows in place, so an old call is graded against the current prompt. The version used is recorded on each result.
- **Ultravox transcripts have no timestamps**, so evidence points to a turn, not a moment in the audio.
- **The judge varies on borderline calls.** Re-running the same call can flip a borderline failure. Treat single borderline failures as "check this", and use the transcript links.
- **One shared admin login, no roles.** Everyone signed in can do everything, and `triggered_by` can't tell people apart. Per-user accounts and roles come later.
- **Changing the password doesn't end existing sessions.** They last until they expire (`AUDIT_SESSION_HOURS`). To sign everyone out now, run `DELETE FROM audit_session` on the audit DB.
- **The sign-in throttle counts by connecting address and lives in memory.** Behind a proxy every client shares the proxy's address, so 10 bad tries lock everyone out for 15 minutes; a restart clears it.
- **The planted cases are synthetic.** They prove the judge catches each defect, not that it agrees with your reviewers. For v2, `eval:v2` measures that on the golden set, which fills up from reviews (none exist until the review buttons, P2-4 / P2-18).
- **One judge call per audit.** Scores vary a little between runs; re-running and comparing (self-consistency) would tighten confidence.

**What counts as a loop.** Repeating a question 3+ times only fails the call when the agent ignored
a clear answer or repeated itself mechanically. Re-asking because the reply was missing, unclear,
garbled or a request to repeat ("sorry?", silence) is good recovery, not a loop.
