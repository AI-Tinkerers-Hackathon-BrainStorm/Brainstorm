import type { Metadata } from "next";
import { AuthGate } from "@/components/auth/AuthGate";
import { SightLoopApp } from "@/src/components/SightLoopApp";

export const metadata: Metadata = {
  title: "SightJarvis · Visual assistance",
};

export default function AppPage() {
  return (
    <AuthGate>
      <SightLoopApp />
    </AuthGate>
  );
}
