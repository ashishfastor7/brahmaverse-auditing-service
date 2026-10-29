import { createHash, randomBytes } from "node:crypto";
import { QueryTypes, type Sequelize } from "sequelize";

/** A signed-in dashboard session. Only the SHA-256 of its token is stored, so a leaked table can't sign anyone in. */
export type Session = { username: string; expires_at: Date };

export interface SessionStore {
  create(tokenHash: string, session: Session): Promise<void>;
  find(tokenHash: string): Promise<Session | null>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

/** A new session token (256 random bits, URL-safe) and the hash that is stored for it. */
export function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Sessions in `audit_session` (migration 0014). */
export function dbSessionStore(db: () => Sequelize): SessionStore {
  return {
    async create(tokenHash, { username, expires_at }) {
      await db().query("INSERT INTO audit_session (token_hash, username, expires_at) VALUES ($1, $2, $3)", {
        bind: [tokenHash, username, expires_at],
      });
    },
    async find(tokenHash) {
      const [row] = await db().query<Session>("SELECT username, expires_at FROM audit_session WHERE token_hash = $1", {
        bind: [tokenHash],
        type: QueryTypes.SELECT,
      });
      return row ? { username: row.username, expires_at: new Date(row.expires_at) } : null;
    },
    async delete(tokenHash) {
      await db().query("DELETE FROM audit_session WHERE token_hash = $1", { bind: [tokenHash] });
    },
    async deleteExpired(now) {
      await db().query("DELETE FROM audit_session WHERE expires_at <= $1", { bind: [now] });
    },
  };
}

/** Sessions in memory, for unit tests. */
export function memorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async create(tokenHash, session) {
      sessions.set(tokenHash, session);
    },
    async find(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },
    async delete(tokenHash) {
      sessions.delete(tokenHash);
    },
    async deleteExpired(now) {
      for (const [hash, s] of sessions) if (s.expires_at <= now) sessions.delete(hash);
    },
  };
}
