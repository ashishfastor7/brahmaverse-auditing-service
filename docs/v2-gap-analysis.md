# v2 gap analysis

What the code has today against each section of `docs/prd-v2.md` (sections 3–9). Paths are relative to the
repo root. Ordered work is in `docs/v2-tasks.md`; conflicts and unknowns are in its **Open** section.

## Today in one paragraph

One OpenAI call per audit (`src/audit/judge/openai-judge.ts`, strict JSON schema, temperature 0 or a reasoning
effort) grades the transcript against a code-defined rubric (`src/audit/rubrics/`). Rule checks run in code
(`src/audit/rules.ts`). Every quote the judge cites is checked against the transcript (`src/audit/evidence.ts`).
`src/audit/score.ts` turns five fixed categories (20 points each) into a 0–100 score. Any failure condition fails
the call, and the score of a failed call is capped at 40. Results go into one table, `audit_results`
(`src/db/models/audit-result.ts`), as JSONB plus a few headline columns. The dashboard (`dashboard/src/pages/`)
lists every call live from integration-service's `voice_call_logs` and joins each one to its latest audit.

## Call data format (transcripts, variables, recordings)

Calls are read, never written, from integration-service's `voice_call_logs` (`src/services/call-source.db.ts`) and
normalised into `AuditInput` (`src/audit/normalize.ts`, `src/audit/types.ts`).

**Checked against the data on 2026-10-22.** Read-only queries on the **dev** database behind `SOURCE_DB_*`
(`brainey-integration`, ~4,600 calls), plus range reads of 25 recording headers from S3. Production may differ.

- **Transcript:** the `transcriptions` column, a JSON array (sometimes stored as a JSON string) of
  `{ speaker, text }`. `speaker` is `"agent"` or `"user"`; `role`/`content` are accepted too.
  - **No per-turn timestamps, confirmed.** All 23,244 turns on completed calls have exactly the keys `speaker` and
    `text`, for every voice provider (`ultravox`, `brahmaverse`, and older rows with none). No timing, word timing or
    ASR confidence sits elsewhere on the row either: `data` and `meta_data` have no timing keys. The only times
    are per call (below).
  - Ultravox transcripts start with an injected `(New Call) Respond as if you are answering the phone.` line;
    `brahmaverse` ones don't. User speech is sometimes split across two turns (`"I"`, then `"Manually"`).
  - `normalize.ts` drops empty and injected lines, then numbers turns from 1. Evidence is `{ turn, quote }`, never a time.
- **Call variables:** `data.config.variables`, a flat `Record<string, string | number | boolean>`. **Only calls
  from late September 2026 on have a `data` column** (Hansa 10 of 845 completed calls, Project manager 15 of 423,
  Caller 78 of 315); older calls carry no variables. `data` also holds `agent_code`, `tools`, `system_ref_id`,
  `metadata` and `config` (`prompt_code`, `voice`, `is_playground`, `max_duration`). Variables per agent:

  | Agent | Variables (on every call unless noted) |
  | --- | --- |
  | Hansa (1) | `candidate_name`, `candidate_email`, `candidate_phone_number`, `candidate_current_company`, `candidate_current_job`, `candidate_total_experience`, `candidate_relevant_experience`, `candidate_skills`, `candidate_relevant_skills` (+ `_count` for both), `candidate_fit_score`, `job_title`, `job_role`, `job_type`, `job_location`, `job_location_type`, `job_working_days`, `job_working_hours`, `job_joining_type`, `job_salary_range`, `job_starting_salary`, `job_max_salary`, `job_salary_period`, `job_skills_required` (+ `_count`), `company_name`, `about_company`, `application_source`, `applied_on`, `agent_name`, `current_time`; sometimes `currently_working` (7/10), `screening_questions` (6/10), `confirmed_slot` (1/10) |
  | Project manager (4) | `name`, `agent_name`, `company_name`, `call_type`, `followup_type`, `requester_name`, `tasks` (CSV: task id, name, due date, progress…), `questions`, `known_names` (CSV of user ids and names), `prompt` |
  | Caller (9) | `name`, `agent_name`, `call_type`, `current_time`, `context`, `guidelines`, `prompt` (the compiled `STEP_n` flow) |

- **Tool scope:** `data.tools` is on every call that has `data`: `{ items: [...], context: {...} }`.
  - `items` lists the tools the agent could call. A save tool carries its JSON **schema, including a `required`
    list**: Hansa's `submitScreeningCallOutcome` requires `currently_working`, `total_experience`, `notice_period`,
    `passout_year`; Caller's `finishConversation` requires only `status`, with the flow's fields
    (`name_confirmed`, `business_type`, `lead_handling`, `twenty_min_demo`…) optional; Project manager's
    `submitFollowupOutcome` takes `task_updates` limited to the call's task ids.
  - `search_knowledgebase` carries the **knowledge-base scope**, e.g. `context.document_ids: [1070]`.
  - The top-level `context` holds ids: Hansa `application_id`, `job_id`; Caller `conversation_id`,
    `workflow_id`, `workflow_execution_id`, `conversation_node_id`, `campaign_id`, `document_group`, `document_ids`.

- **Outcome:** the `outcome` column, a flat object of what the agent saved. There is no separate disposition field.
  It is **mostly empty**: completed calls from July to October 2026 with an outcome are Hansa 4 of 116, Project
  manager 65 of 299 (64 of them in August, none since September), Caller 118 of 286.
  - From 2026-08-20 to 2026-09-08, 113 calls also stored raw **tool payloads** under the tool's name
    (`finishConversation`, `submitFollowupOutcome`, `bookMeetingSlot`, `reportBlocker`, `submitScreeningCallOutcome`,
    `completeConversationStep`…). That stopped on 2026-09-08.
  - Keys are not consistent across calls (`current_ctc`, `Current_CTC`, `currenttc`; test keys like `jhj`).
- **Timing fields on the call:** `created_at`, `initiated_at`, `picked_at`, `ends_at`, `duration` (seconds),
  `ended_reason` (e.g. `hangup`, `agent_hangup`, `connection_error`, `system_error`), `status` (`completed`,
  `no_answer`, `failed`, `dialing`, `ongoing`, `queued`, `skipped`).
- **Recording:** `recording_url`, a WAV file in a private S3 bucket (`private/<business_id>/recodings/...`),
  presigned in `src/services/recording.service.ts` when `AWS_*` is set.
  - **Mono, confirmed.** All 25 sampled recordings (all three agents, `ultravox`, `brahmaverse` and older calls,
    October 2025 to October 2026) are 16-bit PCM with **one channel**: agent and caller are mixed together. Sample
    rate is 8 kHz up to mid-2026, then 16 kHz, and 24 kHz on some recent Caller calls. Audio length matches `duration`.
  - Files are stored with content type `application/x-www-form-urlencoded`, which is why the service serves them as
    `audio/wav`.
- **Agent instructions:** not on the row, except Caller's compiled flow in `variables.prompt`. Today's code asks
  ai-service for them over an RPC that only exists if `patches/ai-service-prompt-rpc.patch` is applied
  (`src/services/prompt.service.ts`). It isn't, so audits run without them. v2 reads them read-only instead (see
  "Data held by other services").
- **Snapshot:** each audit row stores the whole normalised call in `audit_results.call` (JSONB), transcript and
  variables included.

**What this means for v2**
- **Latency, dead air, interruptions/overlap, timeline:** nothing stored can drive them. Mono recordings rule out
  splitting channels, so the only routes are timing from the provider API (Ultravox `/messages`, still unchecked,
  needs O3) or diarising the mono audio (P3-1). Until then these metrics are N/A.
- **Data saved (S4):** the call's own save-tool schema in `data.tools` says which outputs were required, so S4 can
  check `outcome` against it on calls from late September on, without an alias list. Most calls saved no outcome,
  so how S4 scores a call with nothing saved still needs deciding (Open #8).
- **Knowledge grounding:** the per-call scope (`document_ids`) is on the row, so P0-12 doesn't need to guess it.

**Example: call 4570 (real, anonymised).** Caller agent, outbound, `plivo` + `brahmaverse`, 12 Oct 2026. Names, the
company and a phone number are replaced; the long `prompt` and `context` variables are cut short here. The full
anonymised row, with `tools`, is `fixtures/real/call-sample.json`. The agent says "Rohan" although `agent_name` is
"Anjali": the flow's STEP_3 text names "Rohan", so this follows the instructions and isn't an agent error.

```json
{
  "id": 4570, "business_id": 657, "agent_id": 9, "status": "completed", "call_type": "outbound",
  "provider": "plivo", "voice_provider": "brahmaverse", "duration": 103, "ended_reason": "hangup",
  "picked_at": "2026-10-12T12:10:14Z", "ends_at": "2026-10-12T12:11:57Z",
  "recording_url": "https://<bucket>.s3.amazonaws.com/private/657/recodings/2026/10/12/<file>.wav",
  "data": {
    "agent_code": "caller",
    "config": {
      "prompt_code": "caller_base_prompt", "voice": "Anjali-Hindi-Urdu", "is_playground": false, "max_duration": 600,
      "variables": {
        "prompt": "## Conversation Flow\n\nHow to read a step:\n- DO: the goal of this step. Say it in your own words…",
        "context": "This is an outbound call to someone who recently showed interest in AI or business growth online…",
        "guidelines": "None beyond what is written here.",
        "agent_name": "Anjali", "name": "<CONTACT_NAME>", "call_type": "outbound",
        "current_time": "Monday, 12 October 2026, 5:39 PM"
      }
    }
  },
  "transcriptions": [
    { "speaker": "agent", "text": "Hi, am I talking to <FIRST_NAME>?" },
    { "speaker": "user",  "text": "Yes" },
    { "speaker": "agent", "text": "Great. Hi <FIRST_NAME>, this is Rohan calling from <COMPANY>. I noticed you'd recently looked into AI for growing your business, so I wanted to check - is now an okay time for a quick chat?" },
    { "speaker": "user",  "text": "Yes, we can have a chat now." },
    { "speaker": "agent", "text": "Are you already using any AI in your business, or is it still early days?" },
    { "speaker": "user",  "text": "I'm already in the AI." },
    { "speaker": "agent", "text": "That's great that you're ahead of most. We help tie it straight to revenue. We basically run your sales and marketing on autopilot with a CRM that follows with your lead. What does your business do, and who are your customers?" },
    { "speaker": "user",  "text": "I" },
    { "speaker": "agent", "text": "Sorry, I didn't catch that. What does your business do, and who are your customers?" },
    { "speaker": "user",  "text": "We are looking at manufacturing and mostly our staff mostly" },
    { "speaker": "agent", "text": "Got it, thanks. How do you currently handle new leads and follow-ups?" },
    { "speaker": "user",  "text": "I" },
    { "speaker": "user",  "text": "Manually" },
    { "speaker": "agent", "text": "Sorry, I didn't catch that. How do you currently handle new leads and follow-ups?" },
    { "speaker": "user",  "text": "Manually." },
    { "speaker": "agent", "text": "Since you're handling things manually right now, switching to an automated system would save you a lot of time and help you convert more leads. Anything else you'd like to know?" },
    { "speaker": "user",  "text": "Like what your company actually does, can you please let me know that." },
    { "speaker": "agent", "text": "We're an AI Growth Engine that combines software with managed services to help businesses attract, capture, nurture, and convert leads. We bring together tools like CRM, automated follow-ups, SEO, and advertising into one platform. What else is on your mind?" }
  ],
  "outcome": null
}
```

Two things the example shows: the agent re-asked after the split `"I"` / `"Manually"` turns, which is the recovery
the loop rule must not count; and `outcome` is `null`, so this call has nothing for S4 to check.

## Data held by other services, and how to read it from here

**Constraint:** every v2 change happens in this repo. Other Brahmaverse repos are read-only to us. Data owned by
other services is reached only the way `voice_call_logs` already is: a separate read-only login that runs SELECTs
(`src/services/call-source.db.ts`), an RPC that already exists, or a provider API used read-only. Credentials for
these come from the owners as **outside requests** (listed in `docs/v2-tasks.md`). They are not tasks. A feature
that can't be built that way is flagged as needing another repo, not planned here.

Found by reading the sibling repos in `Brahmaverse Oneverse/`.

**Agent instructions (prompts)**
- Stored in ai-service's `prompts` table (`prompt_code`, `agent_code`, `business_id` (null = shared),
  `system_prompt`, `version`). A business's own row wins over the shared one.
- At dial time they are rendered by a 27-line `renderTemplate` (`{{var}}`, `{{#if var value}}…{{/if}}`) with
  `call_type` plus the call variables.
- Today's auditor asks ai-service for them over `query.realtime-call.prompt`, an RPC that only exists if
  `patches/ai-service-prompt-rpc.patch` is applied. It isn't, so audits run without instructions.
- **From here:** a read-only ai-service DB login (`AI_DB_*`), the same SELECT ordering, and a copy of
  `renderTemplate` in this repo, with a test that pins its behaviour. The prompt is still today's version, not the
  one used on the call (Open #11).

**Flow steps**
- ai-service's `callflows` table and API were deleted on 2026-06-26 (ai-service commit `3820e67`).
  `config.callflow_id`, still accepted by integration-service, is a leftover.
- **Caller (agent_code `caller`) calls come from Vajra workflows.** The flow is a node/edge graph in
  vajra-app-service's `workflow_versions` (`nodes`, `edges`). Node types are `start_conversation`, `decision`,
  `discuss`, `collect` (fields can be `required`), `webhook`, `say`, `transfer`, `end_conversation`.
  `conversationflowToPrompt` compiles it into numbered `STEP_n` text. The call is dialled with
  `prompt_code: "caller_base_prompt"` and that text as the call variable `prompt`.
  - **Already here:** the compiled steps arrive in `variables.prompt` on every Caller call.
  - **Structured steps from here:** a read-only Vajra DB login (`VAJRA_DB_*`) following
    `voice_call_logs.system_ref_id = "conversation:<id>"` → `conversations.workflow_execution_id` and
    `conversation_node_id` → `workflow_executions.workflow_version_id` → `workflow_versions.nodes/edges`.
- **Hansa and Project manager** flows exist only as prose in `prompts.system_prompt` (see above). There is no
  structured step list, so S3 and flow adherence are judged from the prompt text.

**Knowledge base**
- ai-service stores documents in `knowledgebase_documents` (`document_id`, `business_id`, `agent_code`,
  `document_group`, `title`, full `content`, `status`, `chunk_count`) and embedded chunks in Qdrant
  (`text-embedding-3-small`).
- During a call the agent searches it with the `search_knowledgebase` tool, scoped by `document_ids` or
  `document_group` in the tool context. Vajra passes `knowledge_base_ids` when it builds a flow.
- **From here:** the `AI_DB_*` login reads the full `content` of the documents in scope. Qdrant isn't needed for
  grounding, because the judge can be given the relevant document text directly (truncated like the agent
  prompt).
- The call's scope is in `voice_call_logs.data.tools` (confirmed 2026-10-22: `search_knowledgebase.context.document_ids`,
  and `document_group` in the top-level context). The auditor already selects `data`. Without a scope (calls before
  late September 2026), use all `ready` documents for the business and agent.

**Tool-call logs**
- Ultravox and Vani return tool calls and results in `/api/calls/{id}/messages`. ai-service's `fetchCallDetails`
  drops every message whose role contains `TOOL` before integration-service saves `transcriptions`, so stored
  transcripts never have them.
- **From here, option A (exact):** call the Ultravox API read-only with `voice_call_logs.provider_call_id` and an
  Ultravox API key. This also gets whatever timing fields the messages carry (P0-5). It only works while
  Ultravox still has the call; Vani-provider calls need their own key and endpoint.
- **From here, option B (approximate):** the `AI_DB_*` login reads ai-service's `ai_tool_usages` (`tool_name`,
  `input`, `output`, `status`, `error_message`, `latency_ms`, `business_id`, `agent_code`, `created_at`). It has no
  call id, so rows are matched by business + agent + `picked_at`…`ends_at`. Two calls of the same agent at the
  same time can't be told apart, so those matches are marked ambiguous and lower confidence.
- **Needs another repo (outside request only):** keeping `TOOL` messages in `transcriptions`, storing the
  `call_log_id` that ai-service already receives in `ai_tool_usages`, or re-enabling the commented-out
  `recordToolPayloadOnCallLog` (which copies tool payloads into `outcome` and affects S4).
- vajra-app-service has an `mcp_tool_calls` table linked to `conversation_id`, but nothing in that repo writes
  to it.

**Recordings and call timing**
- Recordings are WAV files in a private S3 bucket. They are already presigned here when `AWS_*` is set. The
  recording-url RPC path depends on `patches/integration-service-voicecall-ended.patch` (not applied), so `AWS_*`
  read access is the in-repo route. The stored files are mono (one mixed channel), so speakers can't be separated by
  channel.
- `joined` and `ended` times are already on the row (`picked_at`, `ends_at`). Nothing finer is stored.

## §3 Dual goal model

**Already exists**
- One goal per rubric, defined in code: `Rubric.goal` (`src/audit/rubrics/types.ts`), filled in by
  `src/audit/rubrics/default.ts` and `src/audit/rubrics/hansa.ts`. Results are `ACHIEVED | NOT_ACHIEVED |
  NOT_APPLICABLE` with per-rubric reason codes. The judge must use a code from the matching bucket
  (`audit-call.ts` fixes a mismatch).
- The goal rate leaves out N/A calls (`src/routes/calls.ts` `/calls/stats`, `src/routes/audits.ts` `/audits/stats`).
- Parts of the system checks already exist as rules or skips. S1: `skipReason` `NOT_COMPLETED` and `NO_TRANSCRIPT`,
  and the `NO_AGENT_SPEECH` rule. S2: the `AGENT_LOOP` rule and the `CALL_ERROR` rule (`src/audit/rules.ts`).
  S4: Hansa's LLM condition `OUTCOME_MISMATCH`.
- Versioning: `rubric.version` is stored on every row and is part of the unique key.
- Connect rate inputs: `sourceCallCounts` (`src/services/call-source.db.ts`) returns call counts by status.

**Must change**
- Split the single `call_goal` into `system_goal` (S1–S4, each Pass/Fail/N/A with a reason and evidence) and
  `business_goal`.
- Business goal outcomes gain `PARTIAL`. Not-achieved reasons move to the PRD taxonomy (not interested, price,
  timing, competitor, needs approval, agent-caused) instead of the per-rubric lists.
- Goals move from code into a versioned `goal_config` per agent. The judge prompt (`src/audit/judge/prompt.ts`)
  receives the goal definitions and the flow instead of inferring them.
- Unanswered calls are already never audited (`fetchSourceCalls` only returns `completed` calls). The connect rate
  needs its own tile instead of being folded into status counts.

**New**
- `goal_config` table and admin editing, a business goal template library, required outputs per goal
  (e.g. `demo_datetime`) checked against `outcome`.
- S3 needs the agent's flow steps. For Caller calls the compiled `STEP_n` flow already arrives in
  `variables.prompt`, and the structured graph is in Vajra `workflow_versions`. For Hansa and Project manager the
  steps exist only as prompt text (see "Data held by other services"). Both are readable from here with
  read-only logins.
- S4 needs a list of required variables and a disposition. Only `outcome` exists, and it is empty on most calls
  (see "Call data format").

**Risks**
- S2's "long dead air" and the "call under 15 s" N/A rule: dead air needs timestamps (none). Duration is available.
- Structured flows exist only for Vajra-built Caller calls, and need a read-only Vajra DB login. For the other
  agents, S3 depends on the judge reading prose instructions.
- Agent prompts are not pinned per call, so an old call is judged against today's instructions.

## §4 Configurable scorecard

**Already exists**
- The fixed 5 × 20 scorecard: `SCORECARD`, `POINTS_PER_CATEGORY`, `JUDGE_SCALE = 10`
  (`src/audit/rubrics/types.ts`). Each category has `checks`, `not_applicable_when` and 0/5/10 anchors, which are
  most of a PRD "metric" rubric.
- N/A categories drop out of the total (`qualityScore` in `src/audit/score.ts`). With equal weights this is exactly
  the §4.2 formula.
- Failure conditions: `COMMON_FAILURES` (`src/audit/rubrics/default.ts`) has the five "already implemented" PRD
  codes, and the loop code is already `AGENT_LOOP`. Hansa adds `DISCRIMINATORY_QUESTION` and `OUTCOME_MISMATCH`.
  The rules add `CALL_ERROR`, `NO_AGENT_SPEECH` and `AGENT_LOOP`. Every definition already says what does not
  count (the loop definition is the model for this).
- Judge enums are built from the rubric, so codes can't drift (`src/audit/judge/schema.ts`). Unknown codes and
  duplicates are dropped (`audit-call.ts`).
- Raw scores are recoverable: `result.metrics[key].score` stores points (judge score × 2), so every judge score
  0–10 maps back exactly.

**Must change**
- Scoring becomes weighted: a pure `score(metrics, weights)` and `passes(score, threshold, autoFail, critical)`.
  Today Pass/Fail ignores the score (any failure fails the call), and 40 is a *cap* on failed calls, not a pass
  threshold.
- Severity: today every condition fails the call. v2 has Critical (fail), Major (zero the linked metric) and Minor
  (count only), set per scorecard. Seeded severities (decided 2026-10-22): `AGENT_LOOP` Major; every other
  current condition, rule or LLM, Critical.
- The judge schema and prompt are built from the scorecard's metric list instead of `SCORECARD`
  (`schema.ts`, `prompt.ts`, the loop in `audit-call.ts`). Weight-0 metrics are left out.
- A flagged condition without evidence is dropped. Today an LLM failure with empty evidence is kept.

**New**
- `scorecard`, `metric`, condition library and per-scorecard severity tables, with draft/published versions.
- Slider UI and a pure rebalancing function. All 10 default metrics start at 10%. It must reproduce the §4.4
  examples exactly, with Language match locked: Flow adherence 10 → 18 gives the other eight 9.0 each, and
  10 → 20 gives 8.8 for the first four and 8.7 for the last four, total 100.0. The meeting's original
  11-metric version (8.7 / 7.0 / 4.4) is kept as an extra test.
- Interruptions and Pronunciation are treated as N/A until audio or timestamps exist, so their 10% is
  re-normalised away instead of scoring 0.
- Re-score from stored raw scores (no LLM call) and *Save as default* (new scorecard version).
- Five new metrics. Transcript-only (feasible now): stalling & filler words (stalling phrases and filler words
  merged into one, counted per 100 agent words, so no timing is needed), repetition, language match (needs
  language ID), flow adherence (needs the flow). Interruptions and pronunciation need audio.
- Twelve new conditions. Text-detectable now: `PREMATURE_HANGUP`, `WRONG_LANGUAGE`,
  `CONTINUED_AFTER_WRONG_PERSON`, `PUSHY_AFTER_DECLINE`, `DENIED_BEING_AI`, `SENSITIVE_DATA_EXPOSED`,
  `OFF_SCOPE_ADVICE`, `OUTCOME_MISRECORDED`. Need missing data: `SKIPPED_REQUIRED_STEP` (required steps: Vajra
  `collect` fields for Caller, prompt text otherwise), `UNRESPONSIVE_AGENT` (timing), `FALSE_ACTION_CLAIM`
  (tool calls: the Ultravox API, or an approximate match on ai-service `ai_tool_usages`). `NO_AGENT_SPEECH` already exists as a rule.
- "New conditions start as Minor for one week."

**Risks**
- Switching to weighted pass/fail and Major severity will move pass rates noticeably. §9's side-by-side week
  exists to explain this.
- 10 metrics plus about 17 conditions in one judge call makes for a long prompt and output. The cost and quality
  of judging that much in one call are untested.
- Rounding to one decimal with an exact 100.0 total needs a defined tie-break. §4.4 now sets it: largest
  remainder, ties to the metric listed first.

## §5 Per-call audit view

**Already exists** (`dashboard/src/pages/CallDetail.tsx`)
- Headline (overall score with "capped by failure", Pass/Fail, goal, auditor confidence), call summary,
  "Why this call failed", scorecard (fixed `SCORECARD_ORDER`, expandable "Why this score"), went well, improvements,
  conclusion, call details, variables, recording (`<audio>`), and a transcript whose cited turns are highlighted
  and reached from `TurnLink`.
- *Audit this call* / *Re-audit* button (`POST /v1/audit/calls/:id/audit` in `src/routes/calls.ts`).

**Must change**
- Four verdict tiles (score + pass, system goal, business goal with extracted outcome, confidence), the S1–S4 list,
  scorecard sorted lowest first, `weights_used` shown next to the score.
- The audit button opens the weight sliders before running (§4.4).
- Re-audit keeps history. Today `runAudit(..., { force: true })` updates the same row in place. A new row only
  appears when the rubric version changes.

**New**
- Inline transcript annotations with the metric name.
- Human review actions (agree / dispute with corrected score / flag) and a `review` table.
- Audit history panel.
- Call timeline with markers that seek the audio.

**Risks**
- The timeline and timestamp evidence links can't be built without timing data (see §7).
- The API has one shared bearer token (`src/middleware/auth.ts`). v2 replaces it with one shared admin
  username/password login and no roles (decided 2026-10-22), so reviewer and "triggered by" record that login, not
  a person.
- The v1 page must stay as it is while the flag is off.

## §6 System dashboard

**Already exists** (`dashboard/src/pages/CallList.tsx`, `src/routes/calls.ts`)
- Tiles: calls in database, audited (with average score), success rate, goal rate (N/A excluded), needs review.
- Filters: agent, call status, direction, audited/not audited, pass/fail, goal, sort, search, and a "Most common
  failures" chip strip that filters the list. `/calls` accepts `from`/`to`, but the UI has no date picker.

**Must change**
- `/calls/stats` takes no date range and recomputes over every audit row in memory on each request. It needs
  date, direction, goal and version filters and a compare-to-previous-period option.
- "Most common failures" becomes *Top failure causes* (failed checks plus lowest metrics, each bar opening its
  calls).

**New**
- `daily_rollup`, refreshed on each audit write and nightly. The nightly refresh only aggregates; it never audits.
- KPI deltas, trend lines with release markers and version breaks, score histogram (5 bins, sub-threshold bins
  highlighted), outcome buckets, metric heatmap, business goal funnel, agent table.
- Denominators on hover, IST/user time zone, warnings under 30 calls or for hand-picked samples, and an
  "as audited / re-scored" toggle.
- The dashboard has no chart library yet (`dashboard/package.json`).

**Risks**
- The call list joins two databases by passing id lists (`only_ids`, `limit: 100_000` in `/calls` score sort).
  That won't scale to a 30-day view, so dashboards must read their own rollups.
- Telling hand-picked from random samples needs the trigger mode stored on each audit.

## §7 Evaluation pipeline and data model

**Already exists**
- One judge call per audit with strict structured output and a zod check (`judge/openai-judge.ts`,
  `judge/schema.ts`). The OpenAI client retries transport errors twice.
- Code, not the LLM, computes the score (`score.ts`). Evidence is validated and turn numbers corrected
  (`evidence.ts`).
- Stored per audit: `judge_model`, `input_tokens`, `output_tokens`, `latency_ms`, `prompt_used` (agent prompt
  code + version), `rubric_version`, status `pending | completed | failed | skipped`, and an idempotency key
  `(source, call_id, rubric_version)`.
- Audits are user-triggered: `POST /calls/:id/audit`, `POST /audits/:id/reaudit`, and the `replay` CLI
  (`src/scripts/replay.ts`). The request stays open for the whole judge call (`idleTimeout: 255` in `src/index.ts`).

**Must change**
- Invalid output currently throws and marks the audit `failed`. v2 retries once (on invalid JSON or evidence
  pointing at missing turns) and then sets `needs_review`.
- The evidence shape gains `ts_start` / `ts_end`. There are no timestamps to fill them yet.
- Re-audit inserts a new row and marks the old one superseded. Weight-only changes re-score without a new row.
- Schema changes go through reversible migrations (CLAUDE.md). Done in P0-1: `bun run migrate` applies the
  numbered Umzug files in `src/db/migrations/`, and `bun run migrate:down` reverts the last one.
- The judge prompt needs a version. The system rules in `prompt.ts` change without one today; only the rubric is
  versioned.

**New**
- Tables `goal_config`, `scorecard`, `metric`, `audit_check`, `metric_result`, `review`, `release_marker`,
  `daily_rollup`. Audit fields `triggered_by`, `batch_id`, `goal_version`, `scorecard_version`, `weights_used`,
  `system_goal`, `business_goal`, `business_reason`, `cost`, `superseded_by`.
- Background batch runner with progress and cancel. There is no queue today; everything runs inside the HTTP
  request.
- A cost estimate before each run, and a deterministic-signals step before the judge.

**Risks**
- The v1 code reads "the latest audit per call" by `updated_at` (`latestAudits` in `src/routes/calls.ts`,
  `/calls/:id`). v2 rows would appear on the v1 page unless rows record which engine wrote them. Handled in P0-4:
  `audit_results.engine`, and every v1 query reads only `engine = 'v1'`. The unique key
  `(source, call_id, rubric_version)` still spans both engines, so v2 must use its own versions or change the key (P1-8).
- `audit_results.call` copies the transcript and variables into every audit row, so PII is duplicated.
- The judge model env value is an alias (`AUDIT_JUDGE_MODEL` default in `src/env.ts`). It must be pinned to a
  dated version for "pinned model version".

## §8 Recommended additions

| # | Feature | Today |
| --- | --- | --- |
| 1 | Bulk and filter-based auditing | None in the UI. `replay --db` is a CLI backfill with agent/date/limit filters |
| 2 | Calibration (golden) set | Partly: `fixtures/planted/` + `bun run eval:planted` checks for planted defects on synthetic Hansa calls. No human labels, no per-metric agreement, no publish gate |
| 3 | Scorecard simulation | None. Possible once raw metric scores and weights are stored separately |
| 4 | Response latency | Not possible from transcripts (no timestamps) |
| 5 | Dead air and talk ratio | Talk ratio by text length is possible. Dead air needs timestamps |
| 6 | Knowledge grounding | Partly: `CRITICAL_HALLUCINATION` checks claims against the agent prompt and variables. The KB is in ai-service `knowledgebase_documents`, readable with a read-only ai-service DB login |
| 7 | Human review queue | Partly: `needs_review` flag, `AUDIT_REVIEW_THRESHOLD`, list filter. No queue, SLA or reviewer |
| 8 | Release markers | None. `prompt_used.version` is recorded per audit |
| 9 | Alerts and digest | None |
| 10 | Caller insights | Partly: `sentiment.start/end/note` from the judge |
| 11 | Weekly top fixes | None |
| 12 | Transcript quality guard | Partly: judge rates `transcript_quality`, which lowers confidence. No ASR confidence in the data |
| 13 | PII redaction | None. Variables and transcript are sent to OpenAI as-is. Phone numbers and tokens are never selected for auditing |
| 14 | Change log and roles | None. One shared token |
| 15 | Export and webhooks | None |
| 16 | Cost per audit | Partly: tokens stored. No price table or cost column |

## §9 Rollout, success metrics, risks

**Already exists**
- Rubric versioning keeps old and new scores apart. `eval:planted` exits non-zero on any miss, so it can gate
  changes to the judge.

**Must change**
- v1 and v2 side by side on the same calls: the unique key allows two rows per call if v2 uses its own version
  string, but every v1 read path must ignore v2 rows (see §7 risk).

**New**
- Feature flag for v2 (none exists). Golden-set agreement measurement (≥ 85% within one scale point), disputed-audit
  rate, audit cost per day, coverage per agent per week.

**Risks**
- The PRD's first risk (judge inconsistency) is visible today: the README notes borderline calls can flip
  between runs.
- Latency, dead air, interruptions, the timeline and timestamp evidence can't be built from stored data: stored
  transcripts have no timestamps and stored recordings are mono (checked 2026-10-22). They depend on timing from
  the provider API (unchecked) or on diarising the audio.
