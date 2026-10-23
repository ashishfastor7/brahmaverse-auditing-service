# CLAUDE.md

Service that audits finished Brahmaverse AI voice calls (Hansa, Project manager, Caller): rule checks + an
OpenAI "judge" produce a score, Pass/Fail, goal result and cited evidence, stored in its own Postgres DB and
shown on a dashboard. README.md is the user-facing spec (result fields, pass/fail rules, known limits) — keep
it in sync when behaviour changes.

## Commands

API (Bun, run from repo root; copy `.env.example` to `.env` first):

```bash
bun install                     # needs NPM_TOKEN (GitHub PAT, read:packages) for @fastor7/message-bus — see bunfig.toml
bun run migrate                 # creates DB_NAME if missing, then applies pending src/db/migrations/ (Umzug)
bun run migrate:down            # reverts the last migration; the baseline (drops audit_results) only with --drop-table
bun run dev                     # API on :8095 (watch mode); `bun run start` without watch
bun run test                    # = bun test src; unit tests with a stub judge, no DB/network
bun run test:db                 # *.db.test.ts on a throwaway DB on the DB_* server (created, then dropped)
bun test src/audit/audit.test.ts -t "ruleFailures"   # single file / test name filter
bun run eval:planted            # REAL judge on fixtures/planted (needs only OPENAI_API_KEY); exits 1 on any miss; output in eval-output/
bun run replay --db --call-id 3507 [--force]         # audit past calls from voice_call_logs (also --agent-id, --from/--to, --limit, --file, --rpc)
```

Lint: no linter or lint script; the checks are `bun run typecheck` and `npm run build` in `dashboard/` (both tsc).
Prettier config (140 cols, double quotes, trailing commas) is in package.json but not installed: `bunx prettier --write <files>`.

Dashboard (`dashboard/`, Vite + React 19 + Tailwind 4 + TanStack Query, uses npm): `npm install && npm run dev`
(:5175), `npm run build`. Copy `dashboard/.env.example`; `VITE_AUDIT_API_URL` defaults to http://localhost:8095;
sign in with `AUDIT_API_TOKEN`. Re-run `eval:planted` after changing a rubric, the judge prompt, or the judge model.

## v2 rules

- `docs/prd-v2.md` is the source of truth for v2; `docs/v2-tasks.md` tracks progress.
- Scoring, weight rebalancing and failure-condition logic must be pure functions with unit tests.
- Every schema change ships with a reversible up/down migration: a new numbered file in `src/db/migrations/` + `index.ts`.
- v1 audits and the current call page must keep working until v2 is switched on by a feature flag.
- v1 code reads and writes only `engine = 'v1'` rows: spread `V1` from `db/models/audit-result.ts` into its queries.
- Never call the LLM in unit tests: use `fixtureJudge(name)` (`fixtures/judge/`, recorded with
  `bun run record:fixture --case <planted>`).
- Audits are never triggered automatically; only by a user action: *Audit this call*, *Audit selected* or
  *Audit all matching* (current filters, optional random sample of N), as in PRD §7. No auto-audit, schedule or event.
  The sync job and `voicecall.ended` subscriber in `src/background/` still exist; don't use or extend them.
- Change only this repo. Read other services' data read-only (DB logins like `SOURCE_DB_*`, existing RPCs); anything
  needing another repo goes under "Outside requests" in `docs/v2-tasks.md`, never into a task or a new patch.

## Architecture

Flow: `voice_call_logs` row (integration-service, read-only) → "Audit this call" (`POST /v1/audit/calls/:id/audit`),
the replay script, or (dormant) the sync job / `voicecall.ended` subscriber → `runAudit` → `audit_results` → dashboard API.

`src/audit/` is the core and is deliberately layered:
- `normalize.ts` turns a raw call row (DB / RPC / JSON file) into `AuditInput`.
- `audit-call.ts` (`auditCall`) is **pure apart from the injected `Judge`**: rules + judge → `AuditResult`.
  Tests and the planted eval call it directly with a stub/real judge. Keep I/O out of it.
- `run-audit.ts` (`runAudit`): persistence wrapper (agent, agent prompt, skip/pending/completed/failed status);
  **idempotent per (source, call_id, rubric_version)** unless `force`.
- `rules.ts`: deterministic failures (`CALL_ERROR`, `NO_AGENT_SPEECH`, `AGENT_LOOP`) and `skipReason`. A rule
  hit wins over the judge reporting the same code.
- `judge/`: prompt builder, strict JSON schema (zod + OpenAI structured output), OpenAI client.
- `evidence.ts`: every quote the judge cites is verified against the transcript; misses lower confidence.
- `score.ts`: score = points over *applicable* categories only; failed calls capped at `fail_score_cap` (40);
  auditor confidence; `needs_review` below `AUDIT_REVIEW_THRESHOLD`.

Rubrics (`src/audit/rubrics/`): five fixed scorecard categories (`SCORECARD` in `types.ts`, 20 pts each, judge
scores 0–10 ×2); a rubric defines what each means, goal reason codes and judge failure conditions. Agents resolve
by `agent_code` **or** `agent_id` (`agentFor` in `rubrics/index.ts`); `agent_code` is empty on most rows.
**Bump a rubric's `version` whenever it changes**; results are keyed by it so old and new scores aren't mixed.
Pass/Fail is not derived from the score: any single failure condition fails the call. Re-asking after an unclear
reply is not an `AGENT_LOOP`; failures must cite every turn involved.

Other pieces:
- `src/services/`: `call-source.db.ts` reads `voice_call_logs` via a separate read-only connection (`SOURCE_DB_*`;
  SELECT only, never phone numbers/tokens/join URLs); `bus.ts`/`call-source.service.ts`/`prompt.service.ts` are
  bus RPCs to integration-service and ai-service; `recording.service.ts` presigns S3 recordings (`audio/wav`).
- `src/routes/` (Hono, under `/v1/audit`, one shared bearer token in `middleware/auth.ts`): `calls.ts` lists calls
  live from the source table joined with the latest audit; `audits.ts` serves/creates audits.
- `src/services/ai.db.ts` / `vajra.db.ts`: optional read-only pools (`AI_DB_*`, `VAJRA_DB_*`, SELECT-only via
  `readonly-db.ts`). The v2 readers in `src/services/v2/` (agent instructions, Caller flow, knowledge base) never
  throw: a missing login or row is `null` + reason. Test them with `fake-db.ts` + `fixtures/readers/`, never a live DB.
- `src/env.ts`: all config via `@t3-oss/env-core` + zod; add new env vars there and to `.env.example`.
- `src/index.ts` sets Bun `idleTimeout: 255` because on-demand audits hold the request open for the judge call.
- `patches/`: unapplied changes for other repos; never depend on them (recordings need `AWS_*`, no agent prompt).
- Imports use the `@/*` → `src/*` alias. Only ever read other services' data; write only to this service's own DB.
