import type { Migration } from "@/db/migrator";

/**
 * Dashboard sign-in sessions (P1-17): one row per signed-in browser. Only the SHA-256 of the session token is stored.
 * Expired rows are deleted at the next sign-in.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `CREATE TABLE audit_session (
      id SERIAL PRIMARY KEY,
      token_hash CHAR(64) NOT NULL CONSTRAINT audit_session_token_hash_key UNIQUE,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL
    )`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE audit_session");
};
