import { QueryCache, QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, X } from "lucide-react";
import { Component, type ReactNode, startTransition, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, authApi, configApi, tokenStore, UnauthorizedError } from "./api";
import "./index.css";
import { applyInitialTheme, ThemeToggle } from "./components/theme";
import { CallDetail } from "./pages/CallDetail";
import { CallDetailV2, CallPage } from "./pages/CallDetailV2";
import { CallList } from "./pages/CallList";
import { Conditions } from "./pages/Conditions";
import { GoalEditorPage, Goals } from "./pages/Goals";
import { ScorecardEditorPage, Scorecards } from "./pages/Scorecards";
import { Login } from "./pages/Login";
import { SpotCheckItem, SpotCheckList } from "./pages/SpotCheck";

/**
 * Hash routes: #/ (all calls, filters in the query string), #/calls/:id, old #/audits/:id links, and the v2 screens:
 * #/calls/:id/audits/:auditId (an older audit), #/calls/:id/v1 (the v1 page), #/spot-check(/:auditId),
 * #/scorecards(/:id), #/goals(/:agent), #/conditions. Route changes are transitions, so a <ViewTransition> can animate
 * them (the call id in the list becoming the call page's title).
 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => startTransition(() => setHash(window.location.hash.slice(1) || "/"));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** A page that throws while rendering shows what failed instead of blanking the whole app; keyed by route, so it resets. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <p role="alert" className="text-sm text-ink">
        This page couldn't be shown: {this.state.error.message}.{" "}
        <a href="#/" className="text-accent hover:underline">
          Back to all calls
        </a>
      </p>
    );
  }
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

/** The header's page links: inline from `sm` up; behind a Menu button on phones (closes on Esc, outside tap, route change). */
function Nav({ links, current }: { links: [string, string][]; current: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [current]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const active = (href: string) => (href === "#/" ? current === "/" || current.startsWith("/calls") : current.startsWith(href.slice(1)));
  const link = (href: string, label: string, extra = ""): ReactNode => (
    <a
      key={href}
      href={href}
      aria-current={active(href) ? "page" : undefined}
      className={`text-sm hover:text-ink ${active(href) ? "font-medium text-ink" : "text-muted"} ${extra}`}
    >
      {label}
    </a>
  );
  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-4 sm:flex">
        {links.map(([href, label]) => link(href, label))}
      </nav>
      <div ref={ref} className="relative sm:hidden">
        <button
          ref={button}
          className="btn btn-ghost btn-compact px-2"
          aria-expanded={open}
          aria-controls="main-menu"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
          Menu
        </button>
        {open && (
          <nav
            id="main-menu"
            aria-label="Main"
            className="menu-pop absolute right-0 z-20 mt-1 flex w-56 flex-col rounded-xl border border-[var(--dialog-edge)] bg-surface p-1 shadow-raised"
          >
            {links.map(([href, label]) => link(href, label, "rounded-md px-3 py-2.5 hover:bg-sunken"))}
          </nav>
        )}
      </div>
    </>
  );
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
  const callV1 = path.match(/^\/calls\/(\d+)\/v1$/);
  const olderAudit = path.match(/^\/calls\/(\d+)\/audits\/(\d+)$/);
  const spotItem = path.match(/^\/spot-check\/(\d+)$/);
  const spotWeek = path === "/spot-check" ? (new URLSearchParams(search).get("week") ?? undefined) : null;
  const oldAudit = path.match(/^\/audits\/(\d+)$/);
  const conditions = path === "/conditions";
  const scorecard = path.match(/^\/scorecards\/([^/]+)$/);
  const goal = path.match(/^\/goals\/([^/]+)$/);
  const adminPage =
    path === "/scorecards" ? (
      <Scorecards />
    ) : scorecard ? (
      <ScorecardEditorPage key={scorecard[1]} id={decodeURIComponent(scorecard[1]!)} />
    ) : path === "/goals" ? (
      <Goals />
    ) : goal ? (
      <GoalEditorPage key={goal[1]} agent={decodeURIComponent(goal[1]!)} />
    ) : conditions ? (
      <Conditions />
    ) : olderAudit ? (
      <CallDetailV2 key={path} id={Number(olderAudit[1])} auditId={Number(olderAudit[2])} />
    ) : spotItem ? (
      <SpotCheckItem key={spotItem[1]} auditId={Number(spotItem[1])} />
    ) : spotWeek !== null ? (
      <SpotCheckList key={spotWeek ?? "current"} week={spotWeek} />
    ) : null;
  const links: [string, string][] = v2
    ? [
        ["#/", "Calls"],
        ["#/spot-check", "Spot-checks"],
        ["#/scorecards", "Scorecards"],
        ["#/goals", "Goals"],
        ["#/conditions", "Failure conditions"],
      ]
    : [];
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <a href="#/" className="text-base font-semibold text-ink">
          Call audits
        </a>
        <div className="flex items-center gap-3">
          {v2 && <Nav links={links} current={path} />}
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
      <PageBoundary key={route}>
        {adminPage ? (
          v2 ? (
            adminPage
          ) : (
            <p className="text-sm text-muted">
              {config.isPending
                ? "Loading…"
                : "Scorecards, goals, failure conditions and spot-checks are part of v2, which is off (AUDIT_V2_ENABLED)."}
            </p>
          )
        ) : call ? (
          // With v2 on, CallPage picks: v1 page for a call audited only by v1, else the v2 page.
          v2 ? (
            <CallPage key={call[1]} id={Number(call[1])} />
          ) : config.isPending ? null : (
            <CallDetail key={call[1]} id={Number(call[1])} />
          )
        ) : callV1 ? (
          <CallDetail key={callV1[1]} id={Number(callV1[1])} />
        ) : oldAudit ? (
          <AuditRedirect id={Number(oldAudit[1])} />
        ) : (
          <CallList search={search} />
        )}
      </PageBoundary>
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
