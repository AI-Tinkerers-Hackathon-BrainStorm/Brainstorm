/**
 * Computes what a screen reader would announce for an element: its accessible
 * name plus its role. Deliberately a pragmatic subset of the full W3C accname
 * algorithm — enough for the controls this app actually renders.
 */

function textFromIds(root: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function labelFor(element: HTMLElement): string {
  const id = element.getAttribute("id");
  if (!id) return "";
  const label = element.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
  return label?.textContent?.trim() ?? "";
}

export function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = textFromIds(element.ownerDocument, labelledBy);
    if (text) return text;
  }

  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const fromLabel = labelFor(element);
  if (fromLabel) return fromLabel;

  if (element instanceof HTMLImageElement && element.alt.trim()) return element.alt.trim();

  const text = element.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text;

  if (element instanceof HTMLInputElement && element.placeholder.trim()) return element.placeholder.trim();

  return element.getAttribute("title")?.trim() ?? "";
}

export function roleDescription(element: HTMLElement): string {
  const tag = element.tagName;
  const explicitRole = element.getAttribute("role");

  if (/^H[1-6]$/.test(tag)) return `heading level ${tag[1]}`;
  if (explicitRole === "switch" || element.getAttribute("aria-checked")) {
    return `switch, ${element.getAttribute("aria-checked") === "true" ? "on" : "off"}`;
  }
  if (tag === "BUTTON" || explicitRole === "button") {
    const pressed = element.getAttribute("aria-pressed");
    if (pressed === "true") return "button, pressed";
    if (pressed === "false") return "button, not pressed";
    return "button";
  }
  if (tag === "A") return "link";
  if (tag === "SELECT") return "dropdown";
  if (tag === "TEXTAREA") return "text area";
  if (element instanceof HTMLInputElement) {
    if (element.type === "password") return "password field";
    if (element.type === "checkbox") return `checkbox, ${element.checked ? "checked" : "unchecked"}`;
    return "text field";
  }
  return explicitRole ?? "";
}

/** The full string spoken when guided navigation lands on an element. */
export function describeElement(element: HTMLElement): string {
  const name = accessibleName(element);
  const role = roleDescription(element);
  const disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
  return [name || "Unlabelled item", role, disabled ? "dimmed" : ""].filter(Boolean).join(", ");
}
