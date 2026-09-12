import { AuthGate } from "@/components/auth/AuthGate";
import { SightLoopApp } from "@/src/components/SightLoopApp";

export default function Home() {
  return (
    <AuthGate>
      <SightLoopApp />
    </AuthGate>
  );
}
