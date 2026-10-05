# Brahmaverse auditing service

Automatically audits every finished AI voice call (Hansa, Varuna, Vajra, …) and shows the results
on a dashboard: a score out of 100, whether the call passed, whether it achieved its goal, what went
well, what went wrong, and evidence for each point.

```
call ends → integration-service publishes "voicecall.ended"
          → audit worker: rule checks + LLM judge (transcript + agent's prompt + goal config)
          → saves an audit_results row → dashboard reads it
```

It is its own service with its own database. It never writes to another service's database.

## What each call gets

| Field | Meaning |
|---|---|
| `overall_score` | 0–100. The quality score, capped at 40 if the call failed. `null` if nothing could be scored (e.g. wrong person picked up). |
| `call_success` | `PASS`, or `FAIL` with the reason codes that triggered it. One failure condition is enough to fail. |
| `call_goal` | `ACHIEVED` / `NOT_ACHIEVED` / `NOT_APPLICABLE`, with a reason code. Not-applicable calls are left out of the goal rate. |
| `metrics` | Each rubric dimension scored 0–4 against written anchors, with reasoning and transcript quotes. A dimension the call never reached (e.g. questions after a callback request) is marked not applicable and left out of the score. |
| `went_well` / `went_wrong` | The most useful points for a reviewer, each tied to a transcript turn. |
| `sentiment` | The other party's mood at the start and end. |
| `auditor_confidence` | How far to trust this audit. Below `AUDIT_REVIEW_THRESHOLD`, the call is flagged for human review. |
| `rubric_version` | Which rubric produced the score. Bump it when the rubric changes so old and new scores aren't mixed. |

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
src/background/       voicecall.ended subscriber
src/routes/           dashboard API (/v1/audit/...)
src/scripts/          replay (audit past calls), eval-planted (test the judge)
fixtures/planted/     synthetic Hansa calls, each with one planted defect
patches/              changes the other services need (see below)
dashboard/            Vite + React dashboard (call list, call detail)
```

## Setup

```bash
cp .env.example .env            # fill in DB_PASSWORD, MESSAGE_BUS_PASSWORD, OPENAI_API_KEY, AUDIT_API_TOKEN
export NPM_TOKEN=<GitHub PAT with read:packages>   # for @fastor7/message-bus
bun install
bun run migrate                 # creates the database and the audit_results table
bun run dev                     # API on :8095, subscribes to voicecall.ended

cd dashboard && cp .env.example .env && npm install && npm run dev   # dashboard on :5175
```

Sign in to the dashboard with the value of `AUDIT_API_TOKEN`.

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
| integration-service | Publishes `voicecall.ended` from `finalizeCallEnd` (fire-and-forget, never blocks quota or callbacks), plus `query.voicecall.recording-url` so the dashboard can play recordings. Unit tests included. | No automatic audits (use `replay`); no audio in the dashboard. |
| ai-service | `query.realtime-call.prompt`: the agent's system prompt rendered with the call's variables. | Calls are graded without the agent's instructions. Made-up job facts can't be detected, and confidence drops by 0.05. |

## Testing

```bash
bun test                        # unit tests: rules, evidence checks, scoring, result shape (stub judge)
bun run eval:planted            # real judge on 10 planted-defect Hansa calls; exits 1 on any miss
```

`eval:planted` needs only `OPENAI_API_KEY`, with no database or bus. Re-run it before changing the
rubric, the judge prompt or the model. Full judge output is written to `eval-output/`.

To audit real calls without the event:

```bash
# from a DataGrip export of voice_call_logs rows (JSON array)
bun run replay --file calls.json --limit 20

# or through integration-service's existing query.voicecall.list RPC
bun run replay --rpc --business-id 10 --agent-code hrms --limit 20
```

## Known limits

- **Prompt versions aren't pinned per call.** ai-service edits prompt rows in place, so an old call is graded against the current prompt. The version used is recorded on each result.
- **Ultravox transcripts have no timestamps**, so evidence points to a turn, not a moment in the audio.
- **The dashboard uses one shared token.** It's an internal tool for now; per-business access would reuse the existing user JWTs.
- **The planted cases are synthetic.** They prove the judge catches each defect, not that it agrees with your reviewers. Next step: hand-score ~30 real Hansa calls and compare.
- **One judge call per audit.** Scores vary a little between runs; re-running and comparing (self-consistency) would tighten confidence.
