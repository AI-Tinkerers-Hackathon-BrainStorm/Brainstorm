"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DemoAuthProvider } from "./DemoAuthProvider.ts";
import type { AuthProvider, AuthStatus, User } from "./types.ts";

interface AuthApi {
  user?: User;
  status: AuthStatus;
  signIn: (email: string, password: string) => Promise<void>;
  signInAsDemoUser: (userId: string) => Promise<void>;
  signInAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  /** localStorage namespace for this user's agent memory. */
  memoryKey: string;
}

const AuthContext = createContext<AuthApi | null>(null);

/** Swap this single line when the real backend lands. */
function createAuthProvider(): AuthProvider {
  return new DemoAuthProvider();
}

export function AuthContextProvider({ children }: { children: ReactNode }) {
  const providerRef = useRef<AuthProvider>(createAuthProvider());
  const [user, setUser] = useState<User | undefined>(undefined);
  const [status, setStatus] = useState<AuthStatus>("loading");

  // localStorage is unavailable during server rendering, so the session is
  // restored after mount. "loading" prevents a hydration mismatch.
  useEffect(() => {
    const session = providerRef.current.restore();
    setUser(session?.user);
    setStatus(session ? "authenticated" : "unauthenticated");
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await providerRef.current.signIn(email, password);
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  const signInAsDemoUser = useCallback(async (userId: string) => {
    const session = await providerRef.current.signInAsDemoUser(userId);
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  const signInAsGuest = useCallback(async () => {
    const session = await providerRef.current.signInAsGuest();
    setUser(session.user);
    setStatus("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    await providerRef.current.signOut();
    setUser(undefined);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo<AuthApi>(() => ({
    user,
    status,
    signIn,
    signInAsDemoUser,
    signInAsGuest,
    signOut,
    memoryKey: `sightloop:memory:v1:${user?.id ?? "anonymous"}`,
  }), [user, status, signIn, signInAsDemoUser, signInAsGuest, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthContextProvider");
  return context;
}
