"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LoaderCircle, Lock, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppleIcon, GoogleIcon } from "@/components/auth/BrandIcons";
import { useAuth } from "@/src/auth/AuthContext";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/src/auth/demoUsers.ts";

type Pending = null | "credentials" | "guest" | string;

export function LoginForm() {
  const router = useRouter();
  const { signIn, signInAsDemoUser, signInAsGuest } = useAuth();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>(null);

  const busy = pending !== null;

  async function run(key: Pending, action: () => Promise<void>) {
    setError("");
    setPending(key);
    try {
      await action();
      router.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Please try again.");
      // Return focus to the first field so a screen reader user can correct it
      // immediately instead of hunting for where the error came from.
      emailRef.current?.focus();
    } finally {
      setPending(null);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Enter both your email address and your password.");
      emailRef.current?.focus();
      return;
    }
    void run("credentials", () => signIn(email, password));
  }

  function notAvailable(providerName: string) {
    setError(`${providerName} sign-in is not available in this demo build. Use a demo account below.`);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <h1 className="mb-8 text-center text-3xl font-bold tracking-[-0.03em] text-primary dark:text-foreground">
        Login
      </h1>

      {/* role="alert" announces the message the moment it appears, without
          moving focus. Rendered before the fields so a screen reader reaches it
          on the way down. */}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm leading-5 text-destructive"
        >
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={emailId} className="text-sm font-semibold">Email address</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={emailId}
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              placeholder="you@example.com"
              className="h-14 rounded-2xl pl-12 pr-4 text-base"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={passwordId} className="text-sm font-semibold">Password</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id={passwordId}
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              placeholder="Your password"
              className="h-14 rounded-2xl pl-12 pr-14 text-base"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              aria-controls={passwordId}
              className="absolute right-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-xl text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
            </button>
          </div>
        </div>

        <div className="text-center">
          <Button
            type="button"
            variant="link"
            className="h-auto p-2 text-sm underline"
            onClick={() => notAvailable("Password recovery")}
          >
            Forgot Password?
          </Button>
        </div>

        <Button
          type="submit"
          disabled={busy}
          aria-busy={pending === "credentials"}
          className="min-h-14 w-full rounded-2xl text-base font-bold"
        >
          {pending === "credentials" ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /> : null}
          {pending === "credentials" ? "Signing in…" : "Login"}
        </Button>
      </form>

      <div className="relative my-6 text-center text-sm text-muted-foreground">
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
        <span className="relative bg-background px-3">or</span>
      </div>

      <div className="space-y-3">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => notAvailable("Google")}
          className="min-h-14 w-full rounded-2xl text-base font-semibold"
        >
          <GoogleIcon className="size-5" /> Continue with Google
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => notAvailable("Apple")}
          className="min-h-14 w-full rounded-2xl text-base font-semibold"
        >
          <AppleIcon className="size-5" /> Continue with Apple
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          aria-busy={pending === "guest"}
          onClick={() => void run("guest", signInAsGuest)}
          className="min-h-14 w-full rounded-2xl text-base font-semibold"
        >
          <UserRound className="size-5" aria-hidden="true" />
          {pending === "guest" ? "Signing in…" : "Continue as Guest"}
        </Button>
      </div>

      {/* Demo shortcut. Delete this whole section when a real backend exists. */}
      <section aria-labelledby="demo-heading" className="mt-8 rounded-2xl border border-border bg-card p-4">
        <h2 id="demo-heading" className="text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Demo accounts
        </h2>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          Each account keeps its own separate agent memory. Password for all three is{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{DEMO_PASSWORD}</code>.
        </p>
        <ul className="mt-3 space-y-2">
          {DEMO_ACCOUNTS.map((account) => (
            <li key={account.user.id}>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-busy={pending === account.user.id}
                onClick={() => void run(account.user.id, () => signInAsDemoUser(account.user.id))}
                className="min-h-13 w-full justify-start rounded-2xl px-4 text-base font-semibold"
              >
                {pending === account.user.id
                  ? `Signing in as ${account.user.displayName}…`
                  : `Sign in as ${account.user.displayName} (${account.user.email})`}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Need an account?{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-1 text-sm font-bold"
          onClick={() => notAvailable("Sign up")}
        >
          Sign up
        </Button>
      </p>
    </main>
  );
}
