"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { describeElement } from "./accessibleName.ts";
import { speak, stopSpeech } from "./speech.ts";

const STORAGE_KEY = "sightloop:guidednav:v1";
const SWIPE_MIN_DISTANCE = 55;
const TAP_MAX_DRIFT = 14;
const DOUBLE_TAP_MS = 320;
/** A tap landing on one of these produces a real click, so we leave it alone. */
const NATIVE_TAP_TARGETS = "button, a, input, select, textarea, [role='button'], [role='switch']";

/** Elements that count as a "feature" the user can jump to. */
const STOP_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
  "[role='switch']",
  "[data-guided-stop]",
].join(",");

function isNavigable(element: HTMLElement): boolean {
  if (element.closest("[data-guided-skip]")) return false;
  if (element.closest("[aria-hidden='true']")) return false;
  if (element.classList.contains("sr-only")) return false;
  // offsetParent is null for display:none and for position:fixed; check both.
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return element.getClientRects().length > 0;
}

function collectStops(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(STOP_SELECTOR)).filter(isNavigable);
}

interface GuidedNavApi {
  enabled: boolean;
  toggle: () => void;
  enable: () => void;
  disable: () => void;
  next: () => void;
  previous: () => void;
  activate: () => void;
  repeat: () => void;
  position: { index: number; total: number };
  currentLabel: string;
}

const GuidedNavContext = createContext<GuidedNavApi | null>(null);

export function GuidedNavProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [position, setPosition] = useState({ index: 0, total: 0 });
  const [currentLabel, setCurrentLabel] = useState("");
  const currentRef = useRef<HTMLElement | null>(null);
  const enabledRef = useRef(false);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Restoring a persisted preference is a one-shot read of an external store on
  // mount. It cannot run during render because localStorage does not exist on
  // the server, and seeding useState from it would cause a hydration mismatch.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(STORAGE_KEY) === "on") setEnabled(true);
    } catch { /* Private mode: guided navigation simply starts off. */ }
  }, []);

  /**
   * Stops are collected on every move rather than cached, because the app's DOM
   * changes constantly (observations, sheets, camera state). The current element
   * anchors the position so the cursor does not jump when the list changes.
   */
  const moveBy = useCallback((delta: number) => {
    const stops = collectStops();
    if (!stops.length) {
      speak("Nothing to navigate on this screen.");
      return;
    }
    const anchor = currentRef.current;
    const anchorIndex = anchor ? stops.indexOf(anchor) : -1;
    const base = anchorIndex >= 0 ? anchorIndex : -1;
    const nextIndex = Math.max(0, Math.min(stops.length - 1, base + delta));

    const target = stops[nextIndex];
    if (!target) return;

    if (base === nextIndex && anchorIndex >= 0) {
      speak(delta > 0 ? "End of screen." : "Start of screen.");
      return;
    }

    // Headings are not focusable by default; make them programmatically focusable
    // so real DOM focus can carry the cursor (Enter and Space then work natively).
    if (!target.hasAttribute("tabindex") && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
      target.setAttribute("tabindex", "-1");
    }
    target.focus({ preventScroll: false });
    target.scrollIntoView({ block: "center", behavior: "smooth" });

    currentRef.current = target;
    const label = describeElement(target);
    setCurrentLabel(label);
    setPosition({ index: nextIndex + 1, total: stops.length });
    speak(label);
  }, []);

  const next = useCallback(() => moveBy(1), [moveBy]);
  const previous = useCallback(() => moveBy(-1), [moveBy]);

  const activate = useCallback(() => {
    const target = currentRef.current;
    if (!target) {
      speak("Nothing selected. Move to an item first.");
      return;
    }
    if (target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") {
      speak("That item is not available right now.");
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();
      speak("Editing. Type your text, then press Escape to leave guided navigation.");
      return;
    }
    target.click();
  }, []);

  const repeat = useCallback(() => {
    if (currentLabel) speak(currentLabel);
    else speak("Nothing selected yet.");
  }, [currentLabel]);

  const enable = useCallback(() => {
    setEnabled(true);
    try { localStorage.setItem(STORAGE_KEY, "on"); } catch { /* ignored */ }
    speak(
      "Guided navigation on. Swipe right, or press the right arrow key, to move to the next item. " +
      "Double tap an empty area, or press Enter, to activate it.",
    );
  }, []);

  const disable = useCallback(() => {
    setEnabled(false);
    currentRef.current = null;
    setCurrentLabel("");
    setPosition({ index: 0, total: 0 });
    try { localStorage.setItem(STORAGE_KEY, "off"); } catch { /* ignored */ }
    stopSpeech();
    speak("Guided navigation off.");
  }, []);

  const toggle = useCallback(() => {
    if (enabledRef.current) disable();
    else enable();
  }, [disable, enable]);

  // Keyboard: arrow keys move, Enter/Space activate, Escape exits.
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if (event.key === "Escape") {
        event.preventDefault();
        disable();
        return;
      }
      // Never steal arrow keys or Enter while the user is typing in a field.
      if (typing) return;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          previous();
          break;
        case "Enter":
        case " ":
          if (currentRef.current) {
            event.preventDefault();
            activate();
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, next, previous, activate, disable]);

  // Touch: horizontal swipe moves between items.
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      const origin = event.target as HTMLElement | null;
      // Let our own control bar and text fields handle their own touches.
      if (origin?.closest("[data-guided-skip]")) { tracking = false; return; }
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }

    function onTouchEnd(event: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      // A near-stationary touch is a tap, not a swipe. Two of them in quick
      // succession activate the selected item, matching the VoiceOver gesture.
      if (Math.abs(deltaX) < TAP_MAX_DRIFT && Math.abs(deltaY) < TAP_MAX_DRIFT) {
        const origin = event.target as HTMLElement | null;
        // On a real control the browser already fires a click; intercepting
        // would activate it twice.
        if (origin?.closest(NATIVE_TAP_TARGETS)) return;
        const now = Date.now();
        const nearLast =
          Math.abs(touch.clientX - lastTapX) < 48 && Math.abs(touch.clientY - lastTapY) < 48;
        if (now - lastTapAt < DOUBLE_TAP_MS && nearLast) {
          lastTapAt = 0;
          activate();
        } else {
          lastTapAt = now;
          lastTapX = touch.clientX;
          lastTapY = touch.clientY;
        }
        return;
      }

      // Horizontal intent only, so vertical scrolling still works.
      if (Math.abs(deltaX) < SWIPE_MIN_DISTANCE || Math.abs(deltaX) <= Math.abs(deltaY)) return;
      if (deltaX > 0) next();
      else previous();
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [enabled, next, previous, activate]);

  // Keep the fixed control bar from covering the end of the page (WCAG 2.4.11).
  // The reserved space is applied by CSS only at the widths where that bar is
  // actually shown; on phones the bar is hidden and gestures are used instead.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("guided-nav-active", enabled);
    return () => { document.body.classList.remove("guided-nav-active"); };
  }, [enabled]);

  const value = useMemo<GuidedNavApi>(
    () => ({ enabled, toggle, enable, disable, next, previous, activate, repeat, position, currentLabel }),
    [enabled, toggle, enable, disable, next, previous, activate, repeat, position, currentLabel],
  );

  return <GuidedNavContext.Provider value={value}>{children}</GuidedNavContext.Provider>;
}

export function useGuidedNav(): GuidedNavApi {
  const context = useContext(GuidedNavContext);
  if (!context) throw new Error("useGuidedNav must be used inside GuidedNavProvider");
  return context;
}
