/**
 * actions.ts — semantic, element-aware interactions (the layer that justifies
 * the project, same as android-mcp). The caller says tap({ text: "Login" })
 * and we resolve the coordinate from a FRESH tree dump, then act on it via
 * W3C actions — no element ids, no stale-element errors.
 *
 * Coordinate contract: everything the AGENT sees is screenshot pixels;
 * everything WDA touches is points. The conversion happens here, once,
 * via the device scale — never in the agent's head.
 */

import { ensureWda, type WdaClient } from "./wda.ts";
import { getTargetUdid } from "./target.ts";
import { captureFrame, type Frame } from "./screenshot.ts";
import {
  condenseTree,
  matchElements,
  nearestLabels,
  screenSignature,
  screenTitle,
  type Selector,
  type UiElement,
} from "./uitree.ts";

export interface Snapshot {
  elements: UiElement[];
  sparse: boolean;
  ungroupedCount: number;
  rawNodeCount: number;
  /** The raw source root, for signature/title without a second dump. */
  raw: any;
}

/** One fresh tree dump, condensed. Every action starts here. */
export async function snapshot(): Promise<Snapshot> {
  const wda = await client();
  const raw = await wda.source();
  return { ...condenseTree(raw), raw };
}

async function client(): Promise<WdaClient> {
  return ensureWda(await getTargetUdid());
}

/** Device scale (points → pixels multiplier), cached per client. */
const scaleCache = new WeakMap<WdaClient, number>();
export async function deviceScale(wda: WdaClient): Promise<number> {
  const cached = scaleCache.get(wda);
  if (cached) return cached;
  const { scale } = await wda.screenInfo();
  if (!scale || !Number.isFinite(scale)) {
    throw new Error(`WDA reported an unusable screen scale: ${scale}`);
  }
  scaleCache.set(wda, scale);
  return scale;
}

export interface ResolveResult {
  el: UiElement | null;
  sparse: boolean;
  candidates: number;
  nearest: string[];
}

/** Resolve a selector against the live screen (best match, or null). */
export async function resolve(sel: Selector): Promise<ResolveResult> {
  const snap = await snapshot();
  const matches = matchElements(snap.elements, sel);
  return {
    el: matches[0] ?? null,
    sparse: snap.sparse,
    candidates: snap.elements.length,
    nearest: matches[0] ? [] : nearestLabels(snap.elements, sel),
  };
}

function describeSelector(sel: Selector): string {
  return (
    [
      sel.text && `text="${sel.text}"`,
      sel.id && `id="${sel.id}"`,
      sel.type && `type="${sel.type}"`,
    ]
      .filter(Boolean)
      .join(", ") || "(empty selector)"
  );
}

export class ElementNotFound extends Error {
  constructor(sel: Selector, res: ResolveResult) {
    super(
      res.sparse
        ? `No usable accessibility tree on this screen (likely a canvas/game surface). ` +
            `Fall back to \`screenshot\` + \`tap_xy\`. Selector was ${describeSelector(sel)}.`
        : `Element not found: ${describeSelector(sel)}. ` +
            `${res.candidates} elements are on screen` +
            (res.nearest.length
              ? `; closest labels: ${res.nearest.map((l) => `"${l}"`).join(", ")}.`
              : ` — call inspect_screen to see them.`),
    );
    this.name = "ElementNotFound";
  }
}

/* ── W3C action builders (coordinates in POINTS) ───────────────────── */

function tapAction(x: number, y: number) {
  return [
    {
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x, y },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ];
}

function swipeAction(x1: number, y1: number, x2: number, y2: number, ms = 400) {
  return [
    {
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: x1, y: y1 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: ms, x: x2, y: y2 },
        { type: "pause", duration: 60 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ];
}

/* ── Actions ───────────────────────────────────────────────────────── */

/** Tap the element matching the selector. Returns pixel coords + label. */
export async function tap(
  sel: Selector,
): Promise<{ x: number; y: number; label: string }> {
  const res = await resolve(sel);
  if (!res.el) throw new ElementNotFound(sel, res);
  const wda = await client();
  await wda.performActions(tapAction(res.el.center.x, res.el.center.y));
  const scale = await deviceScale(wda);
  return {
    x: Math.round(res.el.center.x * scale),
    y: Math.round(res.el.center.y * scale),
    label: res.el.label || res.el.id || res.el.type,
  };
}

/** Escape hatch for sparse screens: tap SCREENSHOT-PIXEL coordinates. */
export async function tapXY(px: number, py: number): Promise<void> {
  const wda = await client();
  const scale = await deviceScale(wda);
  await wda.performActions(tapAction(px / scale, py / scale));
}

/** Focus an input via selector, then type. Optionally clears it first. */
export async function typeInto(
  sel: Selector,
  text: string,
  clearFirst = false,
): Promise<{ label: string }> {
  const res = await resolve(sel);
  if (!res.el) throw new ElementNotFound(sel, res);
  const wda = await client();
  await wda.performActions(tapAction(res.el.center.x, res.el.center.y));
  await Bun.sleep(400); // keyboard slide-in

  if (clearFirst) {
    // Backspaces sized to the field's current value — reliable across keyboards.
    const len = (res.el.value || "").length || 50;
    await sendKeys(wda, "\u0008".repeat(len), res.el);
  }
  await sendKeys(wda, text, res.el);
  return { label: res.el.label || res.el.id || res.el.type };
}

async function sendKeys(wda: WdaClient, text: string, el: UiElement) {
  try {
    await wda.keys(text);
  } catch (err) {
    const msg = String(err);
    if (/keyboard/i.test(msg)) {
      throw new Error(
        el.type === "SecureTextField"
          ? `Typing failed — "${el.label || el.id}" is a secure field and the keyboard did not accept programmatic input: ${msg}`
          : `Typing failed — no keyboard appeared after focusing "${el.label || el.id}". ` +
              `If the simulator's hardware-keyboard mode re-enabled itself, run: ` +
              `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false (then restart the sim). ${msg}`,
      );
    }
    throw err;
  }
}

/** Poll until a selector resolves (or timeout). */
export async function waitFor(
  sel: Selector,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<{ el: UiElement; elapsedMs: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let last: ResolveResult | null = null;
  while (true) {
    last = await resolve(sel);
    if (last.el) return { el: last.el, elapsedMs: Date.now() - start };
    if (Date.now() >= deadline) break;
    await Bun.sleep(intervalMs);
  }
  throw new ElementNotFound(sel, last!);
}

/** Root bounds in points, for computing swipe strokes. */
async function screenPoints(wda: WdaClient): Promise<{ w: number; h: number }> {
  const raw = await wda.source();
  const tree = condenseTree(raw);
  // The root window rect is the outermost element's bounds envelope; cheaper
  // and version-safe: use /wda/screen statusBarSize width × scale-free window
  // via the raw root rect when present.
  const root = (raw?.value ?? raw)?.rect;
  if (root?.width && root?.height) return { w: root.width, h: root.height };
  // Fallback: envelope of all elements.
  const xs = tree.elements.map((e) => e.bounds.x + e.bounds.w);
  const ys = tree.elements.map((e) => e.bounds.y + e.bounds.h);
  return { w: Math.max(390, ...xs), h: Math.max(700, ...ys) };
}

/** One upward swipe (content scrolls down) over the middle of the screen. */
async function swipeUp(wda: WdaClient): Promise<void> {
  const { w, h } = await screenPoints(wda);
  const x = Math.round(w / 2);
  await wda.performActions(
    swipeAction(x, Math.round(h * 0.7), x, Math.round(h * 0.3)),
  );
  await Bun.sleep(450); // settle: scroll deceleration + re-layout
}

/**
 * Scroll downward until the selector matches, or the tree stops changing
 * (bottom), or maxScrolls is exhausted.
 */
export async function scrollUntil(
  sel: Selector,
  maxScrolls = 10,
): Promise<{
  found: boolean;
  scrolls: number;
  el?: UiElement;
  reachedBottom: boolean;
}> {
  const wda = await client();
  let lastSig = "";
  for (let i = 0; i <= maxScrolls; i++) {
    const raw = await wda.source();
    const tree = condenseTree(raw);
    const match = matchElements(tree.elements, sel)[0];
    if (match)
      return { found: true, scrolls: i, el: match, reachedBottom: false };
    const sig = screenSignature(raw);
    if (sig === lastSig)
      return { found: false, scrolls: i, reachedBottom: true };
    lastSig = sig;
    if (i === maxScrolls) break;
    await swipeUp(wda);
  }
  return { found: false, scrolls: maxScrolls, reachedBottom: false };
}

/* ── Full-page capture (frames, never stitched) ────────────────────── */

export interface FullPageResult {
  frames: Frame[];
  reachedBottom: boolean;
  detection: "tree" | "pixel" | "cap";
}

/** Cheap pixel fingerprint for sparse screens where the tree can't detect
 * the bottom: downscale to 32×64 grayscale and hash the raw bytes. */
async function pixelFingerprint(path: string): Promise<string> {
  const { default: sharp } = await import("sharp");
  const buf = await sharp(path)
    .resize(32, 64, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  let h = 5381;
  for (const b of buf) h = ((h << 5) + h + b) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Scroll to the bottom capturing one overlapping viewport frame per step.
 * Bottom detection: tree signature stops changing; on sparse screens, pixel
 * fingerprint stops changing.
 */
export async function fullPageScreenshot(
  maxFrames = 10,
): Promise<FullPageResult> {
  const udid = await getTargetUdid();
  const wda = await client();

  const frames: Frame[] = [];
  let lastTreeSig = "";
  let lastPixelSig = "";

  for (let i = 0; i < maxFrames; i++) {
    const frame = await captureFrame(
      udid,
      `frame-${String(i + 1).padStart(2, "0")}`,
    );
    frames.push(frame);

    const raw = await wda.source();
    const tree = condenseTree(raw);
    if (!tree.sparse) {
      const sig = screenSignature(raw);
      if (sig === lastTreeSig) {
        return { frames, reachedBottom: true, detection: "tree" };
      }
      lastTreeSig = sig;
    } else {
      const sig = await pixelFingerprint(frame.path);
      if (sig === lastPixelSig) {
        return { frames, reachedBottom: true, detection: "pixel" };
      }
      lastPixelSig = sig;
    }

    if (i < maxFrames - 1) await swipeUp(wda);
  }
  return { frames, reachedBottom: false, detection: "cap" };
}

/* ── current_app (iOS's current_activity) ──────────────────────────── */

export interface CurrentApp {
  bundleId: string;
  pid: number;
  screenSignature: string;
  screenTitle?: string;
}

/**
 * Foreground app + a tree-derived screen fingerprint. Single-window apps
 * (RN/SwiftUI) never change bundle between screens — compare screenSignature
 * across calls to detect navigation.
 */
export async function currentApp(): Promise<CurrentApp> {
  const wda = await client();
  const [info, raw] = await Promise.all([wda.activeAppInfo(), wda.source()]);
  return {
    bundleId: info?.bundleId ?? "",
    pid: info?.pid ?? -1,
    screenSignature: screenSignature(raw),
    screenTitle: screenTitle(raw),
  };
}
