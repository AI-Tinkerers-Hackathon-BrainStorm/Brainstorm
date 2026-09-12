"use client";

import { ChevronLeft, ChevronRight, CircleDot, Repeat2, X } from "lucide-react";
import { useGuidedNav } from "@/src/a11y/GuidedNavContext";

/**
 * Slim bar at the very top of every page. It is the first thing in the DOM, so a
 * screen reader user hears the option immediately, and it never overlaps content.
 */
export function GuidedNavTopBar() {
  const { enabled, toggle } = useGuidedNav();

  return (
    <div data-guided-skip className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-6">
        <p className="text-sm text-muted-foreground">
          {enabled
            ? "Guided navigation is on. Swipe left or right to move, double tap an empty area to activate."
            : "Prefer to be guided through the page by voice?"}
        </p>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={enabled}
          className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border bg-background px-4 text-sm font-bold hover:bg-secondary"
        >
          <CircleDot className="size-4" aria-hidden="true" />
          {enabled ? "Turn off guided navigation" : "Turn on guided navigation"}
        </button>
      </div>
    </div>
  );
}

/**
 * Fixed controls shown only while guided navigation is active, so the feature is
 * usable by tapping as well as by swiping or by keyboard.
 */
export function GuidedNavControls() {
  const { enabled, next, previous, activate, repeat, disable, position, currentLabel } = useGuidedNav();

  if (!enabled) return null;

  return (
    <div
      data-guided-skip
      role="toolbar"
      aria-label="Guided navigation controls"
      className="fixed inset-x-0 bottom-0 z-50 hidden border-t border-border bg-card/98 px-3 py-2 shadow-[0_-8px_30px_rgba(10,20,15,.14)] backdrop-blur sm:block"
    >
      <div className="mx-auto max-w-[1180px]">
        <p className="mb-1.5 truncate text-center text-sm font-semibold">
          {currentLabel || "Press next to start reading the page"}
          {position.total > 0 && (
            <span className="ml-2 font-normal text-muted-foreground">
              {position.index} of {position.total}
            </span>
          )}
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={previous}
            aria-label="Previous item"
            className="grid size-14 place-items-center rounded-2xl border border-border bg-background hover:bg-secondary"
          >
            <ChevronLeft className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={activate}
            className="min-h-14 flex-1 rounded-2xl bg-primary px-4 text-base font-bold text-primary-foreground hover:bg-primary/90"
          >
            Activate this item
          </button>
          <button
            type="button"
            onClick={repeat}
            aria-label="Repeat current item"
            className="grid size-14 place-items-center rounded-2xl border border-border bg-background hover:bg-secondary"
          >
            <Repeat2 className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="Next item"
            className="grid size-14 place-items-center rounded-2xl border border-border bg-background hover:bg-secondary"
          >
            <ChevronRight className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={disable}
            aria-label="Exit guided navigation"
            className="grid size-14 place-items-center rounded-2xl border border-border bg-background hover:bg-secondary"
          >
            <X className="size-6" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
