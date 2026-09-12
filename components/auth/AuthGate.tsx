"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/src/auth/AuthContext";

/**
 * Client-side route protection.
 *
 * Demo build only: the session lives in localStorage, which the server cannot
 * read, so this cannot be enforced in middleware. A real backend should set an
 * httpOnly cookie and gate the route in `middleware.ts` instead.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <p role="status" className="text-base text-muted-foreground">
          {status === "loading" ? "Loading SightLoop…" : "Redirecting to the login page…"}
        </p>
      </main>
    );
  }

  return <>{children}</>;
}
