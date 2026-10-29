import { describe, expect, it } from "bun:test";
import { createMigrator } from "@/db/migrator";
import { dbTestsEnabled, withTestDb } from "@/db/test-db";
import { QueryTypes } from "sequelize";
import { dbSessionStore, newToken } from "./session-store";

describe.skipIf(!dbTestsEnabled)("dbSessionStore (P1-17)", () => {
  it("stores only the token's hash; finds, deletes and clears expired sessions", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const store = dbSessionStore(() => sequelize);
      const live = newToken();
      const old = newToken();
      const expires_at = new Date("2026-10-29T21:00:00.000Z");
      await store.create(live.hash, { username: "admin", expires_at });
      await store.create(old.hash, { username: "admin", expires_at: new Date("2026-10-29T08:00:00.000Z") });

      expect(await store.find(live.hash)).toEqual({ username: "admin", expires_at });
      expect(await store.find(live.token)).toBeNull();
      const rows = await sequelize.query<{ token_hash: string }>("SELECT token_hash FROM audit_session", { type: QueryTypes.SELECT });
      expect(rows.map((r) => r.token_hash).sort()).toEqual([live.hash, old.hash].sort());

      await store.deleteExpired(new Date("2026-10-29T09:00:00.000Z"));
      expect(await store.find(old.hash)).toBeNull();
      expect(await store.find(live.hash)).not.toBeNull();
      await store.delete(live.hash);
      expect(await store.find(live.hash)).toBeNull();
    }));
});
