import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Checks a username and password against the one admin login (`AUDIT_ADMIN_USERNAME` / `AUDIT_ADMIN_PASSWORD`).
 * The password is hashed once (argon2id) and never kept in plain text after that; every check runs the password hash
 * even for a wrong username, so the response time doesn't tell which of the two was wrong.
 */
export function adminCredentials(username: string, password: string) {
  const expectedUser = digest(username);
  const passwordHash = Bun.password.hash(password);
  return async (user: string, pass: string) => {
    const userOk = timingSafeEqual(digest(user), expectedUser);
    const passOk = await Bun.password.verify(pass, await passwordHash);
    return userOk && passOk;
  };
}

export type CredentialCheck = ReturnType<typeof adminCredentials>;

/** Fixed-length digests, so `timingSafeEqual` can compare names of any length. */
const digest = (s: string) => createHash("sha256").update(s).digest();
