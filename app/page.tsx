import type { Metadata } from "next";
import { LandingHero } from "@/components/landing/LandingHero";

export const metadata: Metadata = {
  title: "SightJarvis is back",
  description:
    "A proactive visual agent for blind and low-vision people. It holds your goal, watches the camera over time, remembers what it saw, and speaks only when it has something worth saying.",
};

// Server rendered on purpose: the landing is the page people share, so the hero
// must be in the first response rather than appearing after hydration.
export default function Home() {
  return <LandingHero />;
}
