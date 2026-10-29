import type { Migration } from "@/db/migrator";

/**
 * The golden set (P1-19) lives in `review`: no new table. The golden set is the latest agree / dispute review per call
 * with `in_golden_set`; `bun run eval:v2` compares the judge with it.
 *
 * - `kind`: `normal` (agree / dispute on the call page, P2-4) or `blind` (spot-check given before seeing the judge, P2-18).
 * - The reviewer's answer: `expected_pass_fail`, `expected_business_outcome`, `expected_failure_codes` (the full list),
 *   `corrected_scores` (0007; metric key → score, or null for N/A) and `corrected_checks` (check code → result). On a
 *   normal review a null / missing key means "the audit's value is right"; on a blind one, "not given". A blind review
 *   always gives pass/fail, business outcome and failure codes.
 * - `in_golden_set = false` retires a row (the eval offers the oldest plain agrees once the set passes 150).
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `ALTER TABLE review
      ADD COLUMN kind VARCHAR(255) NOT NULL DEFAULT 'normal' CONSTRAINT review_kind_check CHECK (kind IN ('normal', 'blind')),
      ADD COLUMN expected_pass_fail VARCHAR(255) CONSTRAINT review_expected_pass_fail_check CHECK (expected_pass_fail IN ('PASS', 'FAIL')),
      ADD COLUMN expected_business_outcome VARCHAR(255) CONSTRAINT review_expected_business_outcome_check
        CHECK (expected_business_outcome IN ('ACHIEVED', 'PARTIAL', 'NOT_ACHIEVED', 'NOT_APPLICABLE')),
      ADD COLUMN expected_failure_codes TEXT[],
      ADD COLUMN corrected_checks JSONB CONSTRAINT review_corrected_checks_check CHECK (jsonb_typeof(corrected_checks) = 'object'),
      ADD COLUMN in_golden_set BOOLEAN NOT NULL DEFAULT true,
      ADD CONSTRAINT review_blind_answers_check CHECK (
        kind <> 'blind' OR (expected_pass_fail IS NOT NULL AND expected_business_outcome IS NOT NULL AND expected_failure_codes IS NOT NULL)
      );`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `ALTER TABLE review
      DROP CONSTRAINT review_blind_answers_check,
      DROP COLUMN in_golden_set,
      DROP COLUMN corrected_checks,
      DROP COLUMN expected_failure_codes,
      DROP COLUMN expected_business_outcome,
      DROP COLUMN expected_pass_fail,
      DROP COLUMN kind;`,
  );
};
