import { describe, expect, it } from "bun:test";
import { adminCredentials } from "@/auth/credentials";
import { memorySessionStore } from "@/auth/session-store";
import { loginThrottle } from "@/auth/throttle";
import { type AuthEnv, requireSession, signedInUser } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRouter } from "./auth";

const T0 = new Date("2026-10-29T09:00:00.000Z");
const HOUR = 3_600_000;

/** The auth routes and one protected route, wired as in app.ts, on an in-memory store and a clock the test moves. */
function setup() {
  let now = T0;
  const clock = () => now;
  const store = memorySessionStore();
  const app = new Hono<AuthEnv>();
  app.onError((err, c) => c.json({ message: err.message }, err instanceof HTTPException ? err.status : 500));
  app.route(
    "/v1/audit",
    authRouter({
      store,
      check: adminCredentials("admin", "s3cret-pass"),
      throttle: loginThrottle({ max: 3, now: () => clock().getTime() }),
      sessionHours: 12,
      now: clock,
    }),
  );
  app.use("/v1/audit/*", requireSession(store, clock));
  app.get("/v1/audit/whoami", (c) => c.json({ data: signedInUser(c) }));

  const login = async (username: string, password: string) => {
    const res = await app.request("/v1/audit/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    return { status: res.status, body: (await res.json()) as any, retryAfter: res.headers.get("Retry-After") };
  };
  const get = (path: string, token?: string, method = "GET") =>
    app.request(`/v1/audit${path}`, { method, headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
  return { login, get, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("sign-in (P1-17)", () => {
  it("a good login returns a session token that opens protected routes and records who signed in", async () => {
    const { login, get } = setup();
    const res = await login("admin", "s3cret-pass");
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("admin");
    expect(res.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(res.body.data.expires_at).getTime()).toBe(T0.getTime() + 12 * HOUR);

    const me = await get("/auth/me", res.body.data.token);
    expect([me.status, await me.json()]).toEqual([200, { data: { username: "admin" } }]);
    const protectedRoute = await get("/whoami", res.body.data.token);
    expect([protectedRoute.status, await protectedRoute.json()]).toEqual([200, { data: "admin" }]);
  });

  it("a bad password, an unknown user or a malformed body gets 401 with the same message", async () => {
    const { login } = setup();
    const wrongPassword = await login("admin", "wrong");
    const wrongUser = await login("someone", "s3cret-pass");
    expect(wrongPassword).toEqual({ status: 401, body: { message: "Wrong username or password" }, retryAfter: null });
    expect(wrongUser).toEqual(wrongPassword);
    expect((await login(undefined as any, undefined as any)).status).toBe(401);
  });

  it("an expired session gets 401, and stays rejected", async () => {
    const { login, get, advance } = setup();
    const { token } = (await login("admin", "s3cret-pass")).body.data;
    advance(12 * HOUR - 1);
    expect((await get("/whoami", token)).status).toBe(200);
    advance(1);
    expect((await get("/whoami", token)).status).toBe(401);
    expect((await get("/auth/me", token)).status).toBe(401);
  });

  it("no token, a made-up token and a signed-out token get 401", async () => {
    const { login, get } = setup();
    expect((await get("/whoami")).status).toBe(401);
    expect((await get("/whoami", "not-a-real-token")).status).toBe(401);
    const { token } = (await login("admin", "s3cret-pass")).body.data;
    expect((await get("/auth/logout", token, "POST")).status).toBe(200);
    expect((await get("/whoami", token)).status).toBe(401);
  });

  it("too many failures from one client get 429 until the window ends, even with the right password", async () => {
    const { login, advance } = setup();
    for (let i = 0; i < 3; i++) expect((await login("admin", "wrong")).status).toBe(401);
    const blocked = await login("admin", "s3cret-pass");
    expect([blocked.status, blocked.retryAfter]).toEqual([429, "900"]);
    advance(15 * 60_000);
    expect((await login("admin", "s3cret-pass")).status).toBe(200);
  });
});
