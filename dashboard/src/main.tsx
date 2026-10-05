import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { tokenStore, UnauthorizedError } from "./api";
import "./index.css";
import { CallDetail } from "./pages/CallDetail";
import { CallList } from "./pages/CallList";
import { Login } from "./pages/Login";

/** Hash routes: #/ (list, with filters in the query string) and #/audits/:id. */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function App() {
  const [authed, setAuthed] = useState(() => Boolean(tokenStore.get()));
  const route = useHashRoute();

  useEffect(() => {
    const onLogout = () => setAuthed(false);
    window.addEventListener("audit:logout", onLogout);
    return () => window.removeEventListener("audit:logout", onLogout);
  }, []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const [path, search = ""] = route.split("?");
  const detail = path.match(/^\/audits\/(\d+)$/);
  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <a href="#/" className="text-base font-semibold text-ink">
          Call audits
        </a>
        <button
          className="text-sm text-muted hover:text-ink"
          onClick={() => {
            tokenStore.set(null);
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </header>
      {detail ? <CallDetail id={Number(detail[1])} /> : <CallList search={search} />}
    </div>
  );
}

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
