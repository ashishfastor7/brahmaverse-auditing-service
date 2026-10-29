import { AlertCircle } from "lucide-react";
import { useRef, useState } from "react";
import { authApi, SignInError } from "../api";
import { ThemeToggle } from "../components/theme";
import { Button, Field, Input } from "../components/ui";

const MESSAGES = {
  empty: "Enter your username and password.",
  credentials: "That username or password isn't right. Check both and try again.",
  unreachable: "Can't reach the audit service. Check that it's running, then try again.",
};

const throttledMessage = (seconds: number) => {
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
};

/**
 * One short horizontal shake for a wrong password; none with reduced motion. WAAPI, so a second failure restarts it.
 * WAAPI can't read CSS variables: the curve is --motion-ease-out from index.css; 280ms
 * (under --motion-slow) gives the three swings room.
 */
function shake(el: HTMLElement | null) {
  if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-6px)" },
      { transform: "translateX(5px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

/** Sign-in with the one shared admin login. `notice` explains why the user is here again (their session ended). */
export function Login({ onLogin, notice }: { onLogin: () => void; notice?: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<{ text: string; fields: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLFormElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  // Focus the first field on desktop only: on a phone it would open the keyboard over the page.
  const [focusOnOpen] = useState(() => window.matchMedia?.("(pointer: fine)").matches ?? false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError({ text: MESSAGES.empty, fields: true });
      (username.trim() ? passwordInput.current : usernameInput.current)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.login(username.trim(), password);
      onLogin();
    } catch (err) {
      const reason = err instanceof SignInError ? err.reason : "unreachable";
      if (reason === "credentials") {
        setError({ text: MESSAGES.credentials, fields: true });
        setPassword("");
        passwordInput.current?.focus();
        shake(card.current);
      } else if (reason === "throttled") {
        setError({ text: throttledMessage((err as SignInError).retryAfterSeconds), fields: false });
      } else {
        setError({ text: MESSAGES.unreachable, fields: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const invalid = error?.fields || undefined;
  return (
    <main className="relative flex min-h-dvh items-center justify-center px-4 py-16">
      <ThemeToggle className="absolute right-4 top-4" />
      <form ref={card} onSubmit={submit} noValidate className="w-full max-w-sm rounded-xl border border-line bg-surface p-6" aria-labelledby="sign-in-title">
        <h1 id="sign-in-title" className="text-xl font-semibold text-ink">
          Call audits
        </h1>
        <p className="mt-1 text-sm text-muted">Sign in with the shared admin login.</p>

        {notice && !error && (
          <p role="status" className="mt-4 rounded-md border border-line bg-sunken px-3 py-2 text-sm text-ink">
            {notice}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-4">
          <Field label="Username" htmlFor="username">
            <Input
              ref={usernameInput}
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus={focusOnOpen}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              aria-invalid={invalid}
              aria-describedby={error ? "sign-in-error" : undefined}
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <div className="relative">
              <Input
                ref={passwordInput}
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                aria-invalid={invalid}
                aria-describedby={error ? "sign-in-error" : undefined}
                className="pr-16"
              />
              <Button
                type="button"
                variant="ghost"
                compact
                className="absolute right-1 top-1/2 h-7! -translate-y-1/2 px-2! text-xs"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-controls="password"
                onClick={() => setShowPassword((s) => !s)}
              >
                {showPassword ? "Hide" : "Show"}
              </Button>
            </div>
          </Field>
        </div>

        {error && (
          <p id="sign-in-error" role="alert" className="enter-settle mt-4 flex items-start gap-2 text-sm text-ink">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-critical" aria-hidden />
            {error.text}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="mt-5 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
