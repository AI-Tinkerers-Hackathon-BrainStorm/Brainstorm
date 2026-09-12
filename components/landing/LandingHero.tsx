"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowRight, Eye, ShieldAlert, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { playBootSound } from "@/src/landing/bootSound.ts";

const INTRO_KEY = "sightloop:intro:v1";

function alreadyPlayed(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "done";
  } catch {
    return false;
  }
}

function markPlayed(): void {
  try {
    localStorage.setItem(INTRO_KEY, "done");
  } catch {
    /* Private browsing: the intro simply plays again next time. */
  }
}

export function LandingHero() {
  const armedRef = useRef(false);

  // The chime plays once per browser. Autoplay policy blocks audio before a
  // gesture, so when the immediate attempt fails we arm a single listener and
  // let the first tap or keypress start it instead.
  useEffect(() => {
    if (alreadyPlayed() || armedRef.current) return;
    armedRef.current = true;

    if (playBootSound()) {
      markPlayed();
      return;
    }

    const start = () => {
      if (playBootSound()) markPlayed();
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, []);

  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#050706] text-white">
      {/* Everything in this layer is decoration and is hidden from assistive
          technology; the same information is in the headings and text below. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="sj-grid absolute inset-0" />
        <div className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2">
          <div className="sj-bloom relative grid size-[min(78vw,30rem)] place-items-center">
            <div className="sj-ring absolute inset-0 rounded-full border border-[#f4d448]/25" />
            <div className="sj-ring-alt absolute inset-[9%] rounded-full border border-dashed border-[#f4d448]/35" />
            <div className="sj-ring absolute inset-[19%] rounded-full border-2 border-[#f4d448]/20" />
            <div className="absolute inset-[30%] rounded-full bg-[#f4d448]/5 blur-2xl" />
            <div className="sj-core grid size-[26%] place-items-center rounded-full bg-[#f4d448] shadow-[0_0_60px_18px_rgba(244,212,72,.35)]">
              <Eye className="size-1/2 text-[#0b0f0d]" strokeWidth={2.4} />
            </div>
          </div>
        </div>
        <div className="sj-scan absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-transparent via-[#f4d448]/10 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#050706] via-transparent to-[#050706]/70" />
      </div>

      <div className="relative mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        <p className="sj-rise sj-delay-1 mb-5 rounded-full border border-[#f4d448]/35 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.3em] text-[#f4d448]">
          System online
        </p>

        <h1 className="sj-rise sj-delay-2 text-balance text-5xl font-black leading-[1.05] tracking-[-0.045em] sm:text-7xl">
          SightJarvis <span className="text-[#f4d448]">is back</span>
        </h1>

        <p className="sj-rise sj-delay-3 mx-auto mt-6 max-w-xl text-pretty text-lg leading-7 text-white/70">
          A proactive visual agent for blind and low-vision people. It holds your goal,
          watches the camera over time, remembers what it saw, and speaks only when it
          has something worth saying.
        </p>

        <div className="sj-rise sj-delay-4 mt-10 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <Button
            asChild
            className="min-h-14 w-full rounded-2xl bg-[#f4d448] px-8 text-base font-bold text-[#0b0f0d] hover:bg-[#ffe260] sm:w-auto"
          >
            <Link href="/app">
              Enter SightJarvis <ArrowRight className="size-5" aria-hidden="true" />
            </Link>
          </Button>

          <Button
            type="button"
            variant="outline"
            onClick={() => { playBootSound(); markPlayed(); }}
            className="min-h-14 w-full rounded-2xl border-white/25 bg-white/5 px-6 text-base font-semibold text-white hover:bg-white/10 sm:w-auto"
          >
            <Volume2 className="size-5" aria-hidden="true" /> Play the intro sound
          </Button>
        </div>

        <p className="sj-rise sj-delay-4 mt-10 flex max-w-lg items-start gap-2 text-left text-sm leading-5 text-white/45">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Experimental visual assistance. Do not rely on it as your sole mobility or
          safety aid. Raw camera video is never stored.
        </p>
      </div>
    </main>
  );
}
