import { QueryCache, QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, authApi, configApi, tokenStore, UnauthorizedError } from "./api";
import "./index.css";
import { applyInitialTheme, ThemeToggle } from "./components/theme";
import { CallDetail } from "./pages/CallDetail";
import { CallList } from "./pages/CallList";
import { Conditions } from "./pages/Conditions";
import { Login } from "./pages/Login";

/** Hash routes: #/ (all calls, filters in the query string), #/calls/:id, #/conditions (v2 only), and old #/audits/:id links. */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** Old audit links (#/audits/:id) open the call they belong to. */
function AuditRedirect({ id }: { id: number }) {
  useEffect(() => {
    api
      .get(id)
      .then((a) => window.location.replace(`#/calls/${a.call_id}`))
      .catch(() => window.location.replace("#/"));
  }, [id]);
  return <p className="text-sm text-muted">Opening call…</p>;
}

function App() {
  const [authed, setAuthed] = useState(() => Boolean(tokenStore.get()));
  const [notice, setNotice] = useState<string | null>(null);
  const route = useHashRoute();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: configApi.get, enabled: authed, staleTime: Infinity });
  const me = useQuery({ queryKey: ["me"], queryFn: authApi.me, enabled: authed, staleTime: Infinity });
  const v2 = config.data?.v2_enabled === true;

  // A 401 anywhere means the session expired or was ended: back to sign-in, saying why.
  useEffect(() => {
    const onLogout = () => {
      queryClient.clear();
      setNotice("Your session ended. Sign in again to continue.");
      setAuthed(false);
    };
    window.addEventListener("audit:logout", onLogout);
    return () => window.removeEventListener("audit:logout", onLogout);
  }, [queryClient]);

  const signOut = async () => {
    await authApi.logout();
    queryClient.clear();
    setNotice(null);
    setAuthed(false);
  };

  if (!authed)
    return (
      <Login
        notice={notice}
        onLogin={() => {
          setNotice(null);
          setAuthed(true);
        }}
      />
    );

  const [path, search = ""] = route.split("?");
  const call = path.match(/^\/calls\/(\d+)$/);
  const oldAudit = path.match(/^\/audits\/(\d+)$/);
  const conditions = path === "/conditions";
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <a href="#/" className="text-base font-semibold text-ink">
          Call audits
        </a>
        <div className="flex items-center gap-3">
          {v2 && (
            <a href="#/conditions" className="text-sm text-muted hover:text-ink">
              Failure conditions
            </a>
          )}
          <ThemeToggle />
          {me.data && (
            <span className="hidden text-sm text-muted sm:inline">
              Signed in as <span className="text-ink">{me.data.username}</span>
            </span>
          )}
          <button className="text-sm text-muted hover:text-ink" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {conditions ? (
        v2 ? (
          <Conditions />
        ) : (
          <p className="text-sm text-muted">{config.isPending ? "Loading…" : "Failure conditions are part of v2, which is off (AUDIT_V2_ENABLED)."}</p>
        )
      ) : call ? (
        <CallDetail key={call[1]} id={Number(call[1])} />
      ) : oldAudit ? (
        <AuditRedirect id={Number(oldAudit[1])} />
      ) : (
        <CallList search={search} />
      )}
    </div>
  );
}

applyInitialTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof UnauthorizedError) && n < 2, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof UnauthorizedError) {
        tokenStore.set(null);
        window.dispatchEvent(new Event("audit:logout"));
      }
    },
  }),
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
