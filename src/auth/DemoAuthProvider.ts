import { DEMO_ACCOUNTS, GUEST_USER } from "./demoUsers.ts";
import { AuthError, type AuthProvider, type Session } from "./types.ts";

const SESSION_KEY = "sightloop:session:v1";

/** A small delay so the UI exercises its real pending/disabled states. */
const SIMULATED_LATENCY_MS = 350;

function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));
}

function persist(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* Private browsing: the session lives only for this page view. */
  }
}

/**
 * Frontend-only authentication.
 *
 * WARNING — demo build only. There is no password hashing, no token, and no
 * server check. Anyone can edit localStorage and sign in as any user. This is
 * acceptable because the app currently holds nothing per-user except on-device
 * agent memory. Replace this entire class before any real deployment.
 */
export class DemoAuthProvider implements AuthProvider {
  async signIn(email: string, password: string): Promise<Session> {
    await wait();
    const normalized = email.trim().toLowerCase();
    const account = DEMO_ACCOUNTS.find((item) => item.user.email === normalized);
    if (!account || account.password !== password) {
      throw new AuthError("That email and password combination is not recognised.", "invalid_credentials");
    }
    const session: Session = { user: account.user, createdAt: Date.now() };
    persist(session);
    return session;
  }

  async signInAsDemoUser(userId: string): Promise<Session> {
    await wait();
    const account = DEMO_ACCOUNTS.find((item) => item.user.id === userId);
    if (!account) throw new AuthError("That demo account does not exist.", "invalid_credentials");
    const session: Session = { user: account.user, createdAt: Date.now() };
    persist(session);
    return session;
  }

  async signInAsGuest(): Promise<Session> {
    await wait();
    const session: Session = { user: GUEST_USER, createdAt: Date.now() };
    persist(session);
    return session;
  }

  async signOut(): Promise<void> {
    persist(null);
  }

  restore(): Session | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<Session>;
      if (!parsed?.user?.id || !parsed.user.email) return null;
      return { user: parsed.user as Session["user"], createdAt: parsed.createdAt ?? Date.now() };
    } catch {
      return null;
    }
  }
}
