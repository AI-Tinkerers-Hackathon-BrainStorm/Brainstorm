export function openNavigation(query: string): void {
  if (typeof window === "undefined") return;
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
}
