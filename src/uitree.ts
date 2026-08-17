/**
 * uitree.ts — the "DOM" engine (port of android-mcp's uitree.ts to WDA /source).
 *
 * WDA's `GET /source?format=json` returns the XCUITest accessibility snapshot
 * for whatever app is frontmost — no instrumentation, no testIDs required.
 * Raw dumps are deep JSON trees full of layout wrappers (RN especially loves
 * XCUIElementTypeOther chains). An agent reading that verbatim burns thousands
 * of tokens per look, so we condense it to ONLY nodes a human could act on,
 * each as a compact record with a center point ready to tap.
 *
 * PURE module: input is the parsed /source JSON, output is data. All geometry
 * is in POINTS (WDA's native unit) — the integration layer converts to
 * screenshot pixels where the agent contract requires it.
 */

/* ── Types ─────────────────────────────────────────────────────────── */

export interface UiElement {
  /** Logical role after grouping: button | input | text | image | switch | slider. */
  role: string;
  /**
   * Human-meaningful label — merged from folded children ("A · B"), cleaned,
   * and FULL length (matching uses this; clip for display with clipLabel()).
   */
  label: string;
  /** Accessibility identifier (`name` in WDA) — for React Native this is testID. */
  id?: string;
  /** Element value: text-field contents, switch "1"/"0", slider %, etc. */
  value?: string;
  /** Raw element type without the XCUIElementType prefix, e.g. "Button". */
  type: string;
  /** Bounds in POINTS. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Pre-computed tap target (bounds center) in POINTS. */
  center: { x: number; y: number };
  enabled: boolean;
  /** True when the element is a tap/type target (button/input/switch/slider). */
  interactive: boolean;
}

export interface Selector {
  /** Matches label/name/value, contains; exact match ranks above substring. */
  text?: string;
  /** Matches accessibility identifier (exact or suffix, mirroring android-mcp). */
  id?: string;
  /** Matches the logical role (or raw XCUIElementType name). */
  type?: string;
}

export interface CondensedTree {
  /** Logical elements after grouping (rows collapsed, roles assigned). */
  elements: UiElement[];
  /** True when the tree is too sparse to trust → caller falls back to vision. */
  sparse: boolean;
  /** Actionable nodes BEFORE grouping (how much grouping collapsed). */
  ungroupedCount: number;
  /** Total nodes in the raw tree. */
  rawNodeCount: number;
}

/* ── WDA node parsing helpers ──────────────────────────────────────── */

interface RawNode {
  type: string;
  label: string;
  name: string;
  value: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  enabled: boolean;
}

/** WDA returns "1"/"0" strings in some versions, booleans in others. */
function toBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "") return dflt;
    return s !== "0" && s !== "false" && s !== "no";
  }
  return dflt;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function shortType(t: unknown): string {
  return str(t).replace(/^XCUIElementType/, "");
}

function parseRect(r: any): RawNode["rect"] {
  if (!r || typeof r !== "object") return null;
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height);
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return null;
  return { x, y, w, h };
}

/**
 * Accept either the /source root node itself or the raw HTTP body
 * `{ value: <tree>, sessionId: … }` — integration shouldn't have to care.
 */
function unwrapRoot(src: any): any {
  if (
    src &&
    typeof src === "object" &&
    !src.type &&
    src.value &&
    typeof src.value === "object" &&
    src.value.type
  ) {
    return src.value;
  }
  return src;
}

function toRaw(node: any): RawNode {
  return {
    type: shortType(node?.type),
    label: str(node?.label),
    name: str(node?.name),
    value: str(node?.value),
    rect: parseRect(node?.rect),
    visible: toBool(node?.isVisible, true),
    enabled: toBool(node?.isEnabled, true),
  };
}

/** Depth-first walk over every node in the tree (document order). */
function walk(root: any, fn: (node: any) => void): void {
  if (!root || typeof root !== "object") return;
  fn(root);
  const kids = Array.isArray(root.children) ? root.children : [];
  for (const child of kids) walk(child, fn);
}

/* ── Label cleaning ────────────────────────────────────────────────── */

/**
 * Clean the noise assistive tech / lazy accessibilityLabels bake into labels
 * (ported from android-mcp's TalkBack cleaning, adapted to iOS conventions):
 *  - "double tap to view Hotlist" → "view Hotlist"   (action-hint prefix)
 *  - "Home, Tab, 1 of 3"          → "Home"           (positional announcement)
 *  - "Submit, button"             → "Submit"         (trailing role word)
 *  - ", , " runs collapsed, whitespace collapsed, stray commas trimmed.
 * The result is still the FULL label (used for matching); callers clip via
 * clipLabel() for display. We strip only pure-noise hints, never real text.
 */
export function cleanLabel(s: string): string {
  return (
    s
      .replace(/\s+/g, " ")
      .replace(/\bdouble[ -]tap(?: and hold)? to /gi, "")
      // Positional announcements baked into labels: "Money Tab 2 of 3" → "Money".
      .replace(/[,\s]*(tab[,\s]*)?\d+\s+of\s+\d+\s*$/i, "")
      // Trailing role announcements: "Submit, button" → "Submit".
      .replace(/,\s*(button|link|image|tab|heading|text field)\s*$/i, "")
      .replace(/(,\s*){2,}/g, ", ") // collapse ", , ," runs
      .replace(/^[\s,]+|[\s,]+$/g, "") // trim stray commas/space at ends
      .trim()
  );
}

/** Clip a label for OUTPUT only — matching always uses the full text. */
export const MAX_LABEL = 80;
export function clipLabel(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL).trimEnd() + "…" : s;
}

/* ── Role classification ───────────────────────────────────────────── */

const INPUT_TYPES = new Set([
  "TextField",
  "SecureTextField",
  "TextView",
  "SearchField",
]);
const BUTTON_TYPES = new Set([
  "Button",
  "Cell",
  "Link",
  "Key",
  "MenuItem",
  "MenuButton",
  "PopUpButton",
  "RadioButton",
  "CheckBox",
  "SegmentedControl",
  "Stepper",
  "PickerWheel",
  "TabBarButton",
]);
const SWITCH_TYPES = new Set(["Switch", "Toggle"]);
const SLIDER_TYPES = new Set(["Slider"]);
const IMAGE_TYPES = new Set(["Image", "Icon"]);
const SCROLL_TYPES = new Set([
  "ScrollView",
  "Table",
  "CollectionView",
  "WebView",
  "Map",
]);
/** Structural containers whose label/name is chrome (app name, bar title),
 * not on-screen text — never kept as orphan text elements. */
const STRUCTURAL_TYPES = new Set([
  "Application",
  "Window",
  "NavigationBar",
  "TabBar",
  "StatusBar",
  "Toolbar",
]);

/** How much of the root an XCUIElementTypeOther may cover and still count as a
 * tap target — RN screens put testIDs on full-screen container Views, and
 * treating those as interactive would swallow every orphan text on screen. */
const OTHER_MAX_ROOT_AREA_FRACTION = 0.85;

interface WorkNode extends UiElement {
  /** Kept so grouping can drop pure scroll containers like android-mcp does. */
  scrollContainer: boolean;
}

function roleOf(n: WorkNode): string {
  if (INPUT_TYPES.has(n.type)) return "input";
  if (SWITCH_TYPES.has(n.type)) return "switch";
  if (SLIDER_TYPES.has(n.type)) return "slider";
  if (n.interactive) return "button";
  if (IMAGE_TYPES.has(n.type)) return "image";
  return "text";
}

/* ── Geometry ──────────────────────────────────────────────────────── */

/** WDA rects are floats; tolerate sub-point wobble when testing containment. */
const EPS = 0.5;

type B = UiElement["bounds"];
const area = (b: B) => b.w * b.h;

/** Does `outer` fully contain `inner` (inclusive, with float tolerance)? */
function contains(outer: B, inner: B): boolean {
  return (
    outer.x <= inner.x + EPS &&
    outer.y <= inner.y + EPS &&
    outer.x + outer.w >= inner.x + inner.w - EPS &&
    outer.y + outer.h >= inner.y + inner.h - EPS
  );
}

/* ── Condense: parse + group ───────────────────────────────────────── */

/**
 * Turn a parsed WDA /source tree into logical elements.
 *
 * A list row arrives as 3–6 nodes (Cell + wrapper Others + StaticTexts). We
 * fold every NON-interactive label into the smallest interactive node that
 * geometrically contains it, drop redundant label-less wrappers, and keep
 * orphan text on its own — ~1 element per visual row, each with a role and a
 * merged, matchable label.
 */
export function condenseTree(sourceRoot: any): CondensedTree {
  const root = unwrapRoot(sourceRoot);
  const rootRaw = toRaw(root);
  const rootArea = rootRaw.rect ? area(rootRaw.rect) : Infinity;

  let rawNodeCount = 0;
  const kept: WorkNode[] = [];

  walk(root, (node) => {
    rawNodeCount++;
    const n = toRaw(node);
    if (!n.rect || n.rect.w <= 0 || n.rect.h <= 0) return; // zero-area / no geometry
    if (!n.visible) return; // exclude isVisible: false

    // Label: accessibility label, falling back to value for StaticText (WDA
    // sometimes puts the visible text only in `value`). `name` is the id.
    const label =
      cleanLabel(n.label) ||
      (n.type === "StaticText" ? cleanLabel(n.value) : "");

    const typedInteractive =
      INPUT_TYPES.has(n.type) ||
      BUTTON_TYPES.has(n.type) ||
      SWITCH_TYPES.has(n.type) ||
      SLIDER_TYPES.has(n.type);
    // RN pressables without accessibilityRole surface as Other-with-identifier;
    // full-screen container Views with testIDs must NOT count (see const above).
    const otherInteractive =
      n.type === "Other" &&
      !!n.name &&
      area(n.rect) < rootArea * OTHER_MAX_ROOT_AREA_FRACTION;
    const interactive = typedInteractive || otherInteractive;
    const scrollContainer = SCROLL_TYPES.has(n.type);
    if (STRUCTURAL_TYPES.has(n.type)) return; // chrome, never an element itself
    // UIScrollView's scroll-indicator decorations surface as named Others
    // ("Vertical scroll bar, 1 page") — system chrome, never a real target.
    if (/^(vertical|horizontal) scroll bar\b/i.test(n.name || n.label)) return;

    // Same actionability gate as android-mcp: interactive, scrollable, or labelled.
    if (!interactive && !scrollContainer && !label) return;

    kept.push({
      role: "", // assigned after grouping
      label,
      id: n.name || undefined,
      value: n.value || undefined,
      type: n.type,
      bounds: n.rect,
      center: {
        x: Math.round(n.rect.x + n.rect.w / 2),
        y: Math.round(n.rect.y + n.rect.h / 2),
      },
      enabled: n.enabled,
      interactive,
      scrollContainer,
    });
  });

  const ungroupedCount = kept.length;
  const elements = dedupe(groupElements(kept));
  // Spec: sparse when fewer than 3 actionable elements — the agent should fall
  // back to screenshot + tap_xy on canvas/game screens.
  const sparse = elements.length < 3;

  return { elements, sparse, ungroupedCount, rawNodeCount };
}

/** WDA snapshots can contain literal twin nodes (same type, label, and rect)
 * for one visual element — keep only the first of each. */
function dedupe(elements: UiElement[]): UiElement[] {
  const seen = new Set<string>();
  return elements.filter((el) => {
    const key = `${el.type}|${el.label}|${el.id ?? ""}|${el.bounds.x},${el.bounds.y},${el.bounds.w},${el.bounds.h}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Collapse the raw node soup into logical elements (android-mcp's L3). */
function groupElements(all: WorkNode[]): UiElement[] {
  const interactive = all
    .filter((n) => n.interactive)
    .sort((a, b) => area(a.bounds) - area(b.bounds)); // smallest first
  const collected = new Map<WorkNode, string[]>();
  const orphans: WorkNode[] = [];

  for (const n of all) {
    const isText = !!n.label && !n.interactive && !n.scrollContainer;
    if (!isText) continue;
    // Attach to the smallest interactive ancestor that contains it.
    const host = interactive.find(
      (h) => h !== n && contains(h.bounds, n.bounds),
    );
    if (host) {
      const arr = collected.get(host) || [];
      arr.push(n.label);
      collected.set(host, arr);
    } else {
      orphans.push(n);
    }
  }

  const out: UiElement[] = [];
  for (const n of interactive) {
    const parts = [n.label, ...(collected.get(n) || [])]
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...new Set(parts)].join(" · ");
    // Drop a label-less wrapper that contains a smaller interactive — the
    // inner one is the real target, so the wrapper is just noise.
    const wrapsAnother =
      !merged &&
      interactive.some((o) => o !== n && contains(n.bounds, o.bounds));
    if (wrapsAnother) continue;

    out.push(finalize(n, merged));
  }
  for (const n of orphans) out.push(finalize(n, n.label));

  // Reading order: top-to-bottom, then left-to-right.
  return out.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function finalize(n: WorkNode, label: string): UiElement {
  const { scrollContainer: _drop, ...el } = n;
  return { ...el, label, role: roleOf(n) };
}

/* ── Selector matching ─────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().trim();

/** Split a merged "A · B · C" label back into its matchable segments. */
function segments(s?: string): string[] {
  return norm(s || "")
    .split(" · ")
    .map((x) => x.trim())
    .filter(Boolean);
}

function typeMatches(el: UiElement, wanted: string): boolean {
  const t = norm(wanted).replace(/^xcuielementtype/, "");
  return el.role === t || norm(el.type) === t;
}

/**
 * All elements matching a selector, best first. Ranking mirrors android-mcp:
 * an EXACT label/id/value match beats a substring match (text:"Play" wins the
 * "Play" segment of "Play · 388 / 650" over the substring hit in "How to
 * play"), then interactive elements beat plain text. Ties keep reading order.
 */
export function matchElements(
  elements: UiElement[],
  sel: Selector,
): UiElement[] {
  const matches = elements.filter((el) => {
    if (sel.id) {
      const id = el.id || "";
      if (id !== sel.id && !id.endsWith(sel.id)) return false;
    }
    if (sel.type && !typeMatches(el, sel.type)) return false;
    if (sel.text) {
      const needle = norm(sel.text);
      const hit = [el.label, el.id, el.value].some(
        (h) => !!h && norm(h).includes(needle),
      );
      if (!hit) return false;
    }
    return true;
  });

  if (matches.length <= 1 || !sel.text) return matches;

  const needle = norm(sel.text);
  const isExact = (el: UiElement) =>
    segments(el.label).includes(needle) ||
    norm(el.id || "") === needle ||
    norm(el.value || "") === needle;
  const score = (el: UiElement) =>
    (isExact(el) ? 2 : 0) + (el.interactive ? 1 : 0);

  return [...matches].sort((a, b) => score(b) - score(a)); // stable → reading order on ties
}

/* ── Nearest labels (tap-miss diagnostics) ─────────────────────────── */

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(needle: string, hay: string): number {
  if (!needle || !hay) return 0;
  if (hay === needle) return 3;
  if (hay.includes(needle) || needle.includes(hay)) return 2;
  const capped = hay.slice(0, 60);
  const d = levenshtein(needle, capped);
  return Math.max(0, 1 - d / Math.max(needle.length, capped.length));
}

/**
 * The n on-screen labels closest to what the selector asked for — used to
 * build "did you mean …?" error messages when a tap/wait misses.
 */
export function nearestLabels(
  elements: UiElement[],
  sel: Selector,
  n = 5,
): string[] {
  const needle = norm(sel.text || sel.id || sel.type || "");
  const labelled = elements.filter((e) => e.label);
  const ranked = needle
    ? [...labelled].sort((a, b) => bestSim(b, needle) - bestSim(a, needle))
    : labelled; // no needle → reading order
  const out: string[] = [];
  for (const el of ranked) {
    const label = clipLabel(el.label);
    if (!out.includes(label)) out.push(label);
    if (out.length >= n) break;
  }
  return out;
}

function bestSim(el: UiElement, needle: string): number {
  const candidates = [...segments(el.label), norm(el.id || "")].filter(Boolean);
  return Math.max(0, ...candidates.map((c) => similarity(needle, c)));
}

/* ── Screen fingerprinting (current_app) ───────────────────────────── */

/** Cheap, stable 32-bit djb2 hash (same as android-mcp's device.ts). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint the screen from its accessibility identifiers + element types.
 * Single-window apps (RN/SwiftUI) never change bundle between screens — two
 * reads with the same bundle but different signatures means navigation
 * happened. Sorted, so recycler reordering doesn't flap the hash.
 */
export function screenSignature(sourceRoot: any): string {
  const root = unwrapRoot(sourceRoot);
  const ids: string[] = [];
  const types: string[] = [];
  walk(root, (node) => {
    const name = str(node?.name);
    if (name) ids.push(name);
    types.push(shortType(node?.type));
  });
  ids.sort();
  types.sort();
  return hash(ids.join("|") + "#" + types.join(","));
}

/**
 * Best-guess screen title: the navigation bar's title when one exists, else
 * the topmost labelled StaticText in the top fifth of the screen.
 */
export function screenTitle(sourceRoot: any): string | undefined {
  const root = unwrapRoot(sourceRoot);
  const rootRect = parseRect(root?.rect);

  // 1. Navigation bar: UIKit sets the bar's name/label to the title; if not,
  //    the first StaticText inside it is the title (back buttons are Buttons).
  let navTitle: string | undefined;
  walk(root, (node) => {
    if (navTitle || shortType(node?.type) !== "NavigationBar") return;
    const own = cleanLabel(str(node?.name)) || cleanLabel(str(node?.label));
    if (own) {
      navTitle = own;
      return;
    }
    walk(node, (inner) => {
      if (navTitle || shortType(inner?.type) !== "StaticText") return;
      const t = cleanLabel(str(inner?.label)) || cleanLabel(str(inner?.value));
      if (t) navTitle = t;
    });
  });
  if (navTitle) return navTitle.slice(0, 60);

  // 2. Topmost prominent StaticText in the top fifth of the screen.
  const cutoff = rootRect ? rootRect.y + rootRect.h * 0.2 : 170;
  const candidates: { y: number; x: number; label: string }[] = [];
  walk(root, (node) => {
    if (shortType(node?.type) !== "StaticText") return;
    if (!toBool(node?.isVisible, true)) return;
    const rect = parseRect(node?.rect);
    if (!rect || rect.w <= 0 || rect.h <= 0 || rect.y >= cutoff) return;
    const label = cleanLabel(str(node?.label)) || cleanLabel(str(node?.value));
    if (label) candidates.push({ y: rect.y, x: rect.x, label });
  });
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  return candidates[0]?.label.slice(0, 60);
}
