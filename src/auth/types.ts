export interface User {
  id: string;
  email: string;
  displayName: string;
  isGuest?: boolean;
}

export interface Session {
  user: User;
  createdAt: number;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type AuthErrorCode = "invalid_credentials" | "unavailable";

export class AuthError extends Error {
  constructor(message: string, readonly code: AuthErrorCode) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * The seam between the UI and whatever actually authenticates a user.
 *
 * The demo implementation compares against a hardcoded array. When the real
 * backend arrives, implement this same interface with fetch() calls and swap it
 * in `AuthContext.tsx` — no component below this boundary needs to change.
 */
export interface AuthProvider {
  /** Email + password sign-in. Rejects with AuthError on bad credentials. */
  signIn(email: string, password: string): Promise<Session>;
  /** One-tap demo shortcut. Delete this method once a real backend exists. */
  signInAsDemoUser(userId: string): Promise<Session>;
  /** Anonymous session with its own isolated memory namespace. */
  signInAsGuest(): Promise<Session>;
  signOut(): Promise<void>;
  /** Synchronously read any persisted session. Returns null when signed out. */
  restore(): Session | null;
}
