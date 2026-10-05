import { useState } from "react";
import { api, tokenStore, UnauthorizedError } from "../api";
import { ThemeToggle } from "../components/theme";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    tokenStore.set(token.trim());
    try {
      await api.agents();
      onLogin();
    } catch (err) {
      tokenStore.set(null);
      setError(err instanceof UnauthorizedError ? "That token was not accepted." : `Could not reach the audit service: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="absolute right-4 top-4" />
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold text-ink">Call audits</h1>
        <p className="mt-1 text-sm text-muted">Enter the audit service's API token.</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="AUDIT_API_TOKEN"
          autoFocus
          className="mt-4 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink focus:outline-2 focus:outline-accent"
        />
        {error && <p className="mt-2 text-sm text-ink">⚠ {error}</p>}
        <button
          disabled={!token.trim() || busy}
          className="mt-4 h-9 w-full rounded-md bg-accent text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
