# v2 tasks

The progress tracker for `docs/prd-v2.md` (the source of truth). Each task is sized for one PR and lists the PRD
section it implements. Tick a box when its PR merges. Current state and file paths are in
`docs/v2-gap-analysis.md`.

Phases follow the PRD §9 roadmap: **P0** foundations, **P1** goals + configurable scorecard + user-triggered
batch audits, **P2** call view + dashboard, **P3** advanced audio signals and later additions. This order is
confirmed (Decisions, 2026-10-22); the PRD's "Phase n" labels in §5, §6 and §8 mean Pn.

Rules for every task (CLAUDE.md "v2 rules"):
- Scoring, rebalancing and failure-condition logic are pure functions with unit tests.
- Schema changes ship as reversible migrations.
- Nothing changes for v1 while the v2 flag is off.
- Unit tests use recorded judge fixtures, never the LLM.
- Audits only start from a user action.
- Every task changes only this repo. Other services' data is read through read-only logins, RPCs that already
  exist, or provider APIs used read-only. What needs someone else is listed under **Outside requests**, not as a
  task.

## P0 — Foundations

- [x] **P0-1 Migration runner** (§7; CLAUDE.md v2 rules)
  - Add Umzug (or sequelize-cli) with numbered `up`/`down` files under `src/db/migrations/`, plus a baseline
    migration that creates today's `audit_results` exactly (columns, indexes, unique key).
  - `bun run migrate` applies pending migrations on a fresh DB and is a no-op on an existing one;
    `bun run migrate:down` reverts the last one. `sequelize.sync({ alter: true })` is gone.
  - CI or a test runs up → down → up on an empty Postgres and the schema matches the baseline.
- [x] **P0-2 v2 feature flag** (§9)
  - `AUDIT_V2_ENABLED` (default `false`) in `src/env.ts` and `.env.example`, exposed to the dashboard via an API
    config endpoint.
  - With the flag off, every existing route returns exactly what it returns today (snapshot tests on `/calls`,
    `/calls/:id`, `/calls/stats`, `/audits*`).
- [x] **P0-3 Recorded judge fixtures** (§7; CLAUDE.md v2 rules)
  - `fixtures/judge/` holds recorded judge outputs. `fixtureJudge(name)` returns them through the existing
    `Judge` type.
  - A script records a fixture from a real run on demand (manual, never in tests).
  - Tests fail if the OpenAI client is constructed under `bun test`.
- [x] **P0-4 Engine column, so v1 never reads v2 rows** (§9)
  - Migration adds `audit_results.engine` (`'v1' | 'v2'`, default `'v1'`, backfilled) with up/down.
  - `latestAudits`, `/calls/:id`, `/calls/stats` and `/audits*` only read `engine = 'v1'` while the flag is off.
    A test inserts a v2 row and shows the v1 page unchanged.
- [ ] **P0-5 Timing-data spike** (§3.1 S2, §4.3, §5.4, §8 #4–5, §9 risks) — doc PR, no code
  - Already answered from stored data (2026-10-22, dev DB; gap analysis "Call data format"): transcripts have no
    per-turn timestamps, and recordings are mono, so a stereo split is ruled out.
  - Still to check, using the Ultravox API read-only (needs O3): whether `/api/calls/{id}/messages` carries
    per-message timing, the same for `brahmaverse` (Vani) calls, and how long past calls stay available.
  - Write the findings in `docs/v2-timing.md` with a recommendation (provider timing or a diarisation step on the
    mono audio) and unblock or re-plan the timing-dependent tasks below.
- [ ] **P0-6 v2 weighted score, pure** (§4.2)
  - `src/audit/v2/score.ts`: `weightedScore(metrics, weights)` implements the §4.2 formula with N/A metrics
    dropped and weights re-normalised, and `passes(score, threshold, autoFailZero, criticalFlagged)`.
  - A call fails if the score is under the threshold, an auto-fail metric scored zero, or a Critical condition was
    flagged (Decisions, 2026-10-22).
  - Unit tests: all-applicable, some N/A, all N/A (null), weight 0 excluded, auto-fail zero, threshold edge (= 40),
    and a clean call with no failure condition scoring 35 fails.
- [ ] **P0-7 Weight rebalancing, pure** (§4.4)
  - `rebalance(weights, movedKey, newValue, lockedKeys)` follows rules 1–5: proportional absorption, locked
    metrics fixed, max = 100 − locked, no negatives with spill-over, one decimal with largest-remainder rounding
    to exactly 100.0.
  - The PRD §4.4 examples are tests, with all 10 metrics at 10 and Language match locked:
    - Flow adherence 10 → 18 gives the other eight 9.0 each.
    - 10 → 20 gives 8.8 for the first four and 8.7 for the last four; ties go to the metric listed first.
  - The meeting's 11-metric version (8.7 / 7.0 / 4.4) is an extra test. Property tests check the total and that
    no weight goes negative.
- [ ] **P0-8 Failure-condition severity, pure** (§4.5)
  - `applySeverity(flags, scorecardConditions, metrics)` returns the critical failures (call fails), the metrics
    zeroed by Major flags, and the Minor flags (counted only). Flags without evidence are dropped.
  - Unit tests for each severity, for an unknown code, and for a flag with no evidence.
- [ ] **P0-9 Read-only connectors for other services' data** (§3, §4.3, §7)
  - Optional `AI_DB_*` and `VAJRA_DB_*` settings in `src/env.ts` and `.env.example`, each with its own small `pg`
    pool, built like `src/services/call-source.db.ts`. SELECT-only queries on named columns; nothing else.
  - When a setting is missing, the feature that needs it degrades (`null` plus a reason) instead of failing the
    audit. Tests use fixtures, not live databases. Credentials: O1, O2.
- [ ] **P0-10 Agent instructions from ai-service's `prompts` table** (§3.3, §7)
  - Read the prompt row (business override first, then the shared row) over `AI_DB_*`, and render it with a copy
    of ai-service's `renderTemplate` plus `call_type` and the call variables. Unit tests pin the copied renderer.
  - Used by the v2 path only. v1 keeps `src/services/prompt.service.ts`, so v1 scores don't move. This replaces
    the need for `patches/ai-service-prompt-rpc.patch` in v2.
- [ ] **P0-11 Caller flow reader** (§3.1 S3, §4.3 flow adherence, §4.5 `SKIPPED_REQUIRED_STEP`)
  - From `system_ref_id = "conversation:<id>"`, follow Vajra `conversations` → `workflow_executions` →
    `workflow_versions` over `VAJRA_DB_*`. Return the step list and the `required` `collect` fields.
  - Calls without a Vajra conversation (Hansa, Project manager, or no login) fall back to the prompt text.
    Unit tests on recorded rows.
- [ ] **P0-12 Knowledge base reader** (§8 #6)
  - Read `ready` `knowledgebase_documents` for the call's business and agent over `AI_DB_*`, scoped by the
    `document_ids` / `document_group` in `voice_call_logs.data.tools` when present (the `search_knowledgebase`
    item's context, confirmed on real rows). Truncate for the judge the way the agent prompt is.
  - Unit tests: scoped, unscoped and empty knowledge base.
- [ ] **P0-13 Tool-call reader** (§4.5 `FALSE_ACTION_CLAIM`, §3.1 S4) — after P0-5
  - Option A: Ultravox `/api/calls/{provider_call_id}/messages`, keeping the `TOOL` messages (O3).
  - Option B: match `ai_tool_usages` rows by business + agent + `picked_at`…`ends_at` (O1), marking overlapping
    calls as ambiguous.
  - The choice follows Open #6. Unit tests on recorded responses, including an ambiguous match.

## P1 — Goals, configurable scorecard, user-triggered batches

- [ ] **P1-1 Config schema: goals, scorecards, metrics, conditions** (§3.2, §3.3, §4.1, §4.5, §7)
  - Migrations (up/down) for `goal_config` (versioned per agent), `scorecard` (versioned, draft/published,
    `pass_threshold`), `metric`, `failure_condition` (shared library) and `scorecard_condition` (enabled + severity).
  - A seed migration recreates today's rubrics as the first template: 5 metrics × 20%, the current goals, and the
    current conditions with the PRD §4.5 severities: `AGENT_LOOP` Major; `CRITICAL_HALLUCINATION`,
    `IGNORED_STOP_REQUEST`, `UNAUTHORIZED_PROMISE`, `UNPROFESSIONAL_CONDUCT`, `CALL_ERROR`, `NO_AGENT_SPEECH`,
    `DISCRIMINATORY_QUESTION` and `OUTCOME_MISMATCH` Critical.
  - Planted fixtures give the same pass/fail as v1, except loop-only calls (Major in v2, so they no longer fail on
    their own) and clean calls under 40 (now fail). Those differences are listed in the test.
- [ ] **P1-2 Audit schema for v2** (§7)
  - Migrations (up/down) add `triggered_by`, `trigger_mode` (`single | selected | filter | sample`), `batch_id`,
    `goal_version`, `scorecard_version`, `weights_used`, `system_goal`, `business_goal`, `business_reason`,
    `judge_prompt_version`, `cost`, `superseded_by`, plus the `audit_check` and `metric_result` tables.
  - v1 rows are untouched. Down drops only what up added.
- [ ] **P1-3 Config resolution** (§3.3, §4)
  - `resolveConfig(agent)` returns the published goal config and scorecard version for an agent, using the same
    `agent_code`/`agent_id` matching as `agentFor`. It is used only by the v2 path; v1 rubrics stay in code.
  - Unit tests for a missing agent, a draft-only scorecard, and version selection.
- [ ] **P1-4 v2 judge schema and prompt** (§3.3, §4.1, §7)
  - Built from the scorecard: one entry per metric with weight > 0, the enabled conditions, goal definitions
    and flow text when available. Output per check and metric: `result`, `score`, `reason`,
    `evidence[{turns, ts_start, ts_end}]` (timestamps nullable), `confidence`.
  - A `JUDGE_PROMPT_VERSION` constant is stored on each audit. Snapshot tests of the prompt for two scorecards;
    weight-0 metrics are absent.
- [ ] **P1-5 System goal checks** (§3.1)
  - Pure rule parts: S1 (status, `picked_at`, at least one agent turn), S2 (ended-by, loop rule, no-response
    from text), S4 (required variables present in `outcome`). LLM parts of S2–S4 come from the judge.
  - Required outputs come from the call's save-tool schema in `data.tools` (its `required` list), falling back to
    the goal config's required outputs on calls without `data`. How S4 scores a call that saved no outcome (most
    calls) follows Open #8. Unit tests use `fixtures/real/call-sample.json`.
  - Each check returns Pass/Fail/N/A with reason and evidence. The system goal passes when every applicable
    check passes. Unit tests per check.
- [ ] **P1-6 Business goal** (§3.2)
  - Outcome `ACHIEVED | PARTIAL | NOT_ACHIEVED | NOT_APPLICABLE`, with required outputs extracted from the
    transcript/outcome and a not-achieved reason from the §3.2 taxonomy.
  - Goal rate = achieved ÷ applicable; `PARTIAL` doesn't count as achieved. The Partial share (partial ÷
    applicable) is returned next to it (Decisions, 2026-10-22). Unit tests.
- [ ] **P1-7 `auditCallV2`** (§7)
  - Pure apart from the injected judge: deterministic signals → judge → `applySeverity` → `weightedScore` →
    system/business goals.
  - Invalid JSON or evidence pointing at missing turns triggers one retry, then `needs_review` instead of a
    failed audit.
  - Fixture tests (P0-3) cover pass, critical fail, major zeroing, retry then needs-review.
- [ ] **P1-8 `runAuditV2` persistence** (§5 item 8, §7)
  - Writes `engine = 'v2'` rows. A re-audit inserts a new row and sets `superseded_by` on the old one, storing
    `weights_used`, versions, cost and `trigger_mode`.
  - Idempotent per (call, scorecard version, goal version, weights) unless forced. Tests use the fixture judge
    and a test DB.
- [ ] **P1-9 Re-score without the LLM** (§4.4)
  - `POST /v1/audit/audits/:id/rescore` with new weights recomputes from the stored `metric_result` rows. No
    judge call, recorded as a re-score of the same audit.
  - Test: re-score with the original weights reproduces the original score.
- [ ] **P1-10 Transcript-only rule metrics** (§4.3)
  - Stalling & filler words (stalling-phrase and filler-word lists, counted per 100 agent words, with count
    bands) and repetition (agent-turn similarity, LLM confirms) as pure functions with params from
    `metric.params`. No timing is needed.
  - Unit tests with Hindi/English mixed lines.
- [ ] **P1-11 Language match metric** (§4.3)
  - Per-turn language ID (pick a library and note its size) and the `WRONG_LANGUAGE` rule input. Borrowed
    English words in Hindi speech don't count.
  - Unit tests on mixed-language fixtures.
- [ ] **P1-12 Text-detectable failure conditions** (§4.5)
  - Add `PREMATURE_HANGUP`, `WRONG_LANGUAGE`, `CONTINUED_AFTER_WRONG_PERSON`, `PUSHY_AFTER_DECLINE`,
    `DENIED_BEING_AI`, `SENSITIVE_DATA_EXPOSED`, `OFF_SCOPE_ADVICE`, `OUTCOME_MISRECORDED` to the library, each
    with a "does not count" clause, starting as Minor.
  - One planted fixture per condition in `fixtures/planted/`. `eval:planted` passes.
- [ ] **P1-13 Batch runner** (§7)
  - `audit_batch` table (migration), in-process worker with a concurrency limit, progress counts, cancel, and
    resume after restart. It only runs batches a user created.
  - Tests: cancel stops new audits, a restart resumes, the fixture judge is used throughout.
- [ ] **P1-14 Weight sliders + pre-run dialog** (§4.4, §5 item 9, §7)
  - Shown when the flag is on, for *Audit this call* and for batches. Pre-filled with scorecard defaults, uses
    `rebalance`, has lock toggles, *Reset to defaults*, and the call count and estimated cost.
  - With the flag off, the v1 button behaves exactly as today.
- [ ] **P1-15 Audit selected** (§2 goal 3, §7)
  - Row checkboxes on the call list, a selection bar, and `POST /v1/audit/batches` with call ids → batch with
    progress.
  - Selecting 3 calls creates one batch of 3 with `trigger_mode = 'selected'`.
- [ ] **P1-16 Audit all matching + random sample** (§2 goal 3, §7, §8 #1)
  - The server resolves the current list filters to call ids (completed calls only), with an optional random
    sample of N and a minimum-duration skip. The dialog shows the count and cost before confirming.
  - `trigger_mode = 'filter' | 'sample'` is stored. Test: the sample is reproducible from a stored seed.
- [ ] **P1-17 Shared admin login** (§4.4, §5 item 7, §7, §8 #14)
  - Replace the shared bearer token with one admin username/password login (credentials in `src/env.ts`, password
    stored hashed, session token returned to the dashboard). No roles: a signed-in user can do everything.
  - Record `triggered_by` (the login) on audits and batches. Wrong credentials get 401; every `/v1/audit/*` route
    except health needs a session.
- [ ] **P1-18 Scorecard and goal admin** (§3.2, §4, §8 #14)
  - Create a draft, edit metrics/weights/conditions/severity, publish as a new version, and log every change
    (what and when; "who" is always the shared login). *Save as default* from the sliders creates a draft or a
    version, per Open #13.
  - Published versions are immutable. Tests cover the versioning rules.
- [ ] **P1-19 Golden set and agreement gate** (§8 #2, §9 success metrics)
  - Import human scores for 50–100 calls. A command measures per-metric agreement (within one scale point)
    using recorded judge runs.
  - Publishing a scorecard or judge-prompt change is blocked below 85%.
- [ ] **P1-20 Scorecard simulation** (§8 #3)
  - Re-score the last N audits with draft weights and show the pass-rate change before publishing. No LLM call.
- [ ] **P1-21 Side-by-side week report** (§9)
  - A command or page comparing v1 and v2 results on the same calls (pass rate, score shift, top changed
    calls), so the jump can be explained before the dashboard switches.

## P2 — Call view and dashboard

- [ ] **P2-1 v2 call page** (§5 items 1–3, 5)
  - Behind the flag: verdict tiles, S1–S4 with reasons, scorecard sorted lowest first with expandable rubric,
    reason and evidence, `weights_used` next to the score. Every deduction links to its turns.
  - The v1 page is unchanged with the flag off.
- [ ] **P2-2 Transcript annotations** (§5 item 6)
  - Flagged turns are highlighted inline with the metric or condition name.
- [ ] **P2-3 Audit history** (§5 item 8)
  - List of re-audits and re-scores with scorecard version, goal version and weights. Opening an older one
    shows it read-only.
- [ ] **P2-4 Human review actions** (§5 item 7)
  - `review` table (migration). Agree / dispute a metric with corrected score and note / flag for review,
    recorded with the reviewer. Disputes feed the golden set (P1-19).
- [ ] **P2-5 Review queue** (§8 #7)
  - Low confidence, disputes, AI-failure bucket and a random 5% sample, with reviewer agreement stats.
- [ ] **P2-6 `daily_rollup`** (§6, §7)
  - Table (migration), refreshed on each audit write plus a nightly aggregation job (aggregation only, never
    audits). IST day buckets.
  - Test: rollup totals equal a direct query over the same audits.
- [ ] **P2-7 Dashboard API and KPI tiles** (§6 items 1–2, behaviour rules)
  - Filters (date range, agent, direction, business goal, scorecard version, compare-to-previous) and KPIs with
    deltas and denominators. The business goal rate tile shows the Partial share next to it (Decisions #12).
  - Warnings when fewer than 30 audited calls back a number or the audits were hand-picked.
- [ ] **P2-8 Charts: trend, histogram, top failure causes, outcome buckets** (§6 items 3–6)
  - Add a chart library. Trend lines break at scorecard version changes. Histogram bins 0–20 … 80–100 with
    sub-threshold bins highlighted. Every bar opens the matching calls.
- [ ] **P2-9 Heatmap, funnel, agent table** (§6 items 7–9)
- [ ] **P2-10 As-audited vs re-scored toggle** (§6 behaviour rules)
  - Re-scores everything with one weight set from stored metric results, without changing stored audits.
- [ ] **P2-11 Release markers** (§6 item 3, §8 #8)
  - `release_marker` table (migration) and CRUD. Markers appear on trends, and two periods or versions can be
    compared.
- [ ] **P2-12 Cost tracking** (§8 #16)
  - Price table per model, `cost` per audit, cost per day on the dashboard, and the estimate used by the
    pre-run dialog.
- [ ] **P2-13 PII redaction before the LLM** (§8 #13)
  - Mask phone, card and ID numbers in transcript and variables before the judge call. Unit tests on fixtures.
- [ ] **P2-14 Transcript quality guard** (§8 #12)
  - Low-quality transcripts mark the audit low-confidence instead of penalising the agent. Uses ASR confidence
    if P0-5 finds any, otherwise the judge's `transcript_quality`.
- [ ] **P2-15 Knowledge grounding check** (§8 #6) — uses P0-12
  - Flags claims (pricing, features, timelines) not supported by the knowledge base documents in scope, with
    evidence. Fixture tests for a supported and an unsupported claim.
- [ ] **P2-16 Response latency, dead air, talk ratio** (§8 #4–5, §3.1 S2) — blocked on P0-5
- [ ] **P2-17 Call timeline** (§5 item 4) — blocked on P0-5
  - Markers for stalls, interruptions, loops, dead air and language switches. Clicking one seeks the audio and
    scrolls the transcript.

## P3 — Advanced audio and later additions

- [ ] **P3-1 Audio pipeline** (§4.3, §9 risks)
  - Fetch the WAV (read-only S3 access, O4), diarise speakers (recordings are mono, so there are no channels to
    split), and produce agent segments with timings, as chosen in P0-5. Runs only inside a user-started audit.
- [ ] **P3-2 Interruptions / overlap metric** (§4.3) — overlap > 300 ms counted
- [ ] **P3-3 Pronunciation and numbers metric** (§4.3) — audio model on agent segments only
- **P3-4 Filler words per minute** — removed. Filler words are now part of "Stalling & filler words" (P1-10),
  counted per 100 agent words, so they don't need speech time.
- [ ] **P3-5 `UNRESPONSIVE_AGENT`, `SKIPPED_REQUIRED_STEP`, `FALSE_ACTION_CLAIM`** (§4.5) — use P0-5 timings,
  P0-11 flows and P0-13 tool calls
- [ ] **P3-6 Alerts and daily digest** (§8 #9)
- [ ] **P3-7 Caller insights** (§8 #10)
- [ ] **P3-8 Weekly top-fixes report** (§8 #11)
- [ ] **P3-9 Export and webhooks** (§8 #15)

## Outside requests

Things only other people can provide. None of them is a code change in another repo, except where noted under
"Needs another repo". Tasks that depend on one degrade gracefully until it arrives.

| # | Request | From | For |
| --- | --- | --- | --- |
| O1 | Read-only Postgres login to ai-service's DB, limited to `prompts`, `knowledgebase_documents`, `ai_tool_usages` | ai-service DB owner | P0-9, P0-10, P0-12, P0-13 (B) |
| O2 | Read-only Postgres login to vajra-app-service's DB, limited to `conversations`, `workflow_executions`, `workflow_versions` | Vajra DB owner | P0-9, P0-11 |
| O3 | Ultravox API key (and the Vani equivalent) for read-only call lookups | Voice platform owner | P0-5, P0-13 (A) |
| O4 | Read-only S3 access to the recordings bucket (`AWS_*`), confirmed in every environment | Infra | P3-1, recordings today |
| O6 | Confirmation that the `SOURCE_DB_*` login is read-only and may run the v2 batch queries | integration-service DB owner | P1-16 |

**Needs another repo (not planned here).** These would need a change in someone else's repo. They are listed
so their owners can decide; no task here depends on them.
- ai-service: keep `TOOL` messages in `fetchCallDetails`, store `call_log_id` in `ai_tool_usages`, re-enable
  `recordToolPayloadOnCallLog`, pin the prompt version on each call.
- The two existing files in `patches/` (agent-prompt RPC, recording-url RPC and `voicecall.ended`). v2 doesn't
  need them: P0-10 replaces the prompt RPC, and O4 covers recordings.

## Open

Ambiguities in the PRD and places where it disagrees with the code. Each needs a decision before the tasks that
depend on it. Items keep their original numbers so references elsewhere stay valid; resolved ones (#1, #4, #9,
#10, #12, #20) are in **Decisions** below.

- **#2 Loop code `"S"`.** §4.5 says the loop code is `"S"` and needs a rename migration. The code uses
  `AGENT_LOOP` in the rubric, the rule and the schema enum. Check stored `audit_results.failure_codes` for `"S"`. If
  there are none, drop the migration.
- **#3 `OUTCOME_MISMATCH` vs `OUTCOME_MISRECORDED`.** Hansa's `OUTCOME_MISMATCH` (kept, Critical) and the PRD's
  proposed `OUTCOME_MISRECORDED` look like the same check. Merge them into one code, or keep both?
- **#5 Timestamps.** §3.1 S2, §4.3, §5 (items 4–5), §7 (`ts_start`/`ts_end`) and §8 #4–5 assume timing data.
  Stored transcripts have none and stored recordings are mono (checked 2026-10-22). Whether the provider API has
  timing is still unknown; P0-5 answers it.
- **#6 Tool-call logs.** `FALSE_ACTION_CLAIM` needs them. Where they are (details in the gap analysis, "Data held by
  other services"):
  - **At the provider.** Ultravox and Vani return tool calls in `/api/calls/{id}/messages`, but ai-service's
    `fetchCallDetails` drops every `TOOL` message before integration-service saves `transcriptions`.
  - **In ai-service's `ai_tool_usages`.** It has every MCP tool call with input, output and status, but no call
    id. `call_log_id` reaches the handler and isn't stored.
  - (Between 2026-08-20 and 2026-09-08, tool payloads were also copied into `outcome`; that stopped.)

  Decide between the two read-only options in P0-13:
  - **(A) Ultravox API (O3).** Exact and per call, but only while Ultravox keeps the call, and Vani calls need
    their own endpoint.
  - **(B) `ai_tool_usages` over the ai-service DB login (O1).** Covers every MCP tool, but is matched by time
    window, so concurrent calls of the same agent are ambiguous.

  Or both, using A first. Storing the call id in ai-service would remove the ambiguity, but that needs another
  repo, so it is listed only as an outside item. `FALSE_ACTION_CLAIM` stays Minor until the match is reliable.
- **#7 Flow definitions and knowledge base.** S3, flow adherence, `SKIPPED_REQUIRED_STEP` and knowledge grounding
  need the agent's step list and KB.
  - **Flows.** ai-service deleted its `callflows` table on 2026-06-26, and `config.callflow_id` is a leftover.
    - Caller calls are built from Vajra `workflow_versions` (node graph, `collect` fields with `required`).
      They arrive already compiled into `STEP_n` text in `variables.prompt`, and link back via
      `system_ref_id = "conversation:<id>"`.
    - Hansa and Project manager have steps only as prose in ai-service `prompts.system_prompt`.
    - Decide whether S3 grades the prompt text for every agent (works now, P0-10) or also uses structured
      Caller steps read over the Vajra DB login (P0-11, needs O2).
  - **Knowledge base.** It lives in ai-service `knowledgebase_documents` (full text) + Qdrant, scoped per call by
    `document_ids` / `document_group` in the tool context.
    - Grounding reads the documents over the ai-service DB login (P0-12, needs O1); Qdrant isn't needed.
    - The per-call scope is in `voice_call_logs.data.tools` (confirmed 2026-10-22), on calls from late September
      2026 on.
- **#8 Disposition for S4.** The PRD checks "disposition" and saved variables. Calls only have `outcome`, and it is
  empty on most calls. The required outputs are known per call (the save-tool schema in `data.tools`). Still to
  decide: is S4 checked only against the call record, and does a call that saved nothing fail S4 or count as N/A?
  (Also a PRD open question.)
- **#11 Prompt versions.** Agent prompts aren't pinned per call: ai-service edits them in place, so an old call is
  graded against today's prompt. This weakens "every verdict traceable" and the side-by-side week. Pinning needs an
  ai-service change (outside, not planned). Here we store the prompt `version` we read and flag audits of calls
  older than that version's `updated_at`.
- **#13 Save as default.** Does it need approval before becoming a version? (Who may use it is decided: anyone
  signed in, see Decisions.)
- **#14 "New conditions start as Minor for one week."** Is that a manual step, or should the severity switch on its
  own after a week? A switch on its own changes scores without a user action.
- **#15 "Unjoined".** §3.1 calls unanswered calls *Unjoined*. That's the providers' `end_reason` for a call that rang
  out and was never picked up. integration-service (`src/controller/voice-call/voice-call.controller.ts`) saves
  those calls with `status = 'no_answer'` and `ended_reason = 'unjoined'`, so "Unjoined" in the PRD means
  `no_answer`. Still open: whether `failed` (dial errors), `skipped` and in-flight statuses (`queued`, `dialing`,
  `ongoing`) count in the connect-rate denominator. Suggested rule: connected = `completed`, not connected =
  `no_answer` + `failed`, everything else excluded.
- **#16 Re-audit history in v1.** v1 re-audits overwrite in place. Should v1 keep that until the flag is on, with
  history v2-only (as planned in P1-8)?
- **#17 Pinned judge model.** §9 asks for a pinned model version. `AUDIT_JUDGE_MODEL` defaults to an alias; which
  dated model id do we pin?
- **#18 PII to the LLM before P2-13.** Transcripts and variables go to OpenAI unredacted today, and §8 puts
  redaction in Phase 2. Is that acceptable for the P1 batch audits, which send many more calls?
- **#19 Default pass threshold and final metric list** stay open in the PRD (§4.3, §9). P1-1 seeds today's values
  until they are decided. The default list is now 10 metrics (stalling phrases and filler words merged), each starting at 10%. The
  slider mockup shows "Pass if score ≥ 60" while §4.2 says 40; the threshold is still to be decided.

## Decisions

### 2026-10-22
- **#1 Pass rule.** A clean call with no failure condition that scores under 40 fails. v2 fails a call on a score
  under the threshold, an auto-fail metric at zero, or any Critical condition. PRD §1 (today's rule corrected) and
  §4.2 updated; P0-6 tests it.
- **#4 Seeded severities.** PRD defaults: `CRITICAL_HALLUCINATION`, `IGNORED_STOP_REQUEST`, `UNAUTHORIZED_PROMISE`
  and `UNPROFESSIONAL_CONDUCT` Critical; `AGENT_LOOP` Major; `CALL_ERROR`, `NO_AGENT_SPEECH`,
  `DISCRIMINATORY_QUESTION` and `OUTCOME_MISMATCH` Critical. PRD §4.5 lists all of them as implemented (their
  "rolls up to" values are Claude's proposal); P1-1 seeds them.
- **#9 Identity.** One shared admin username/password login, no roles for now. Anyone signed in can publish and use
  *Save as default*; `triggered_by` and reviewer record that login. PRD §4.4, §5, §7, §8 #14 updated; P1-17
  rewritten; outside request O5 (user JWT key) dropped.
- **#10 Phases.** P0 foundations → P1 goals and scorecard → P2 call page and dashboard → P3 audio, as in this file.
  PRD §9 states the numbering.
- **#12 Partial outcomes.** The goal rate counts only Achieved calls; the Partial share is shown separately next to
  it. PRD §3.3 and §6 updated, PRD open question ticked; P1-6 updated.
- **#20 Real data example.** Replaced with real call 4570 (anonymised) from the dev database, along with checked facts
  on transcripts (no timestamps), recordings (mono), variables per agent and outcome coverage (gap analysis "Call
  data format"). The full anonymised row, with `data.tools` (save-tool schemas with `required` fields, knowledge-base
  scope), is `fixtures/real/call-sample.json`. P0-5, P0-12, P1-5 and P3-1 updated to match.
