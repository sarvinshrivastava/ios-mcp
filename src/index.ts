#!/usr/bin/env bun
/**
 * index.ts — the MCP server. Registers every tool and speaks stdio so it can
 * be dropped straight into Claude Code / any MCP client.
 *
 * Tool-design rule enforced here (inherited from android-mcp): a tool exists
 * only if it COMPOSES, LOOPS, CONDENSES, or works SEMANTICALLY on the UI tree.
 * Pure 1:1 simctl wrappers (install/uninstall/openurl/push) are intentionally
 * absent — run those with `xcrun simctl` directly.
 *
 * Agent contract: every coordinate an agent sees or sends is SCREENSHOT
 * PIXELS. The point↔pixel conversion happens server-side, always.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listTargets, selectDevice, getTarget, peekTarget } from "./target.ts";
import { ensureWda, killOrphanWda } from "./wda.ts";
import { screenshot } from "./screenshot.ts";
import { readSyslog, resetApp } from "./backend.ts";
import { visualDiff } from "./visualdiff.ts";
import { startRecording, stopRecording, stopAllRecordings } from "./recorder.ts";
import { clipLabel, type UiElement } from "./uitree.ts";
import {
  snapshot,
  resolve,
  tap,
  tapXY,
  typeInto,
  waitFor,
  scrollUntil,
  fullPageScreenshot,
  currentApp,
  deviceScale,
} from "./actions.ts";

/** Shorthand for a text response. */
function text(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

/** Serialize an element for output: label clipped, geometry in PIXELS. */
function toPixels(el: UiElement, scale: number) {
  return {
    role: el.role,
    label: clipLabel(el.label) || undefined,
    id: el.id,
    value: el.value ? clipLabel(el.value) : undefined,
    bounds: {
      x: Math.round(el.bounds.x * scale),
      y: Math.round(el.bounds.y * scale),
      w: Math.round(el.bounds.w * scale),
      h: Math.round(el.bounds.h * scale),
    },
    center: {
      x: Math.round(el.center.x * scale),
      y: Math.round(el.center.y * scale),
    },
    enabled: el.enabled || undefined,
  };
}

async function targetScale(): Promise<number> {
  return deviceScale(await ensureWda(await getTarget()));
}

/** Selector schema shared by every element-aware tool. */
const selectorShape = {
  text: z
    .string()
    .optional()
    .describe("Visible text / accessibility label (contains; exact wins)"),
  id: z
    .string()
    .optional()
    .describe("Accessibility identifier — React Native testID"),
  type: z
    .string()
    .optional()
    .describe("Role (button/input/text/image/switch) or XCUIElementType name"),
};

const server = new McpServer({ name: "ios-mcp", version: "0.1.0" });

/* ── Device selection ─────────────────────────────────────────────── */

server.tool(
  "list_devices",
  "List every target this Mac can drive — iOS simulators AND connected physical devices — with kind (sim/device), name, UDID, iOS version and state (Booted/Shutdown for simulators, Connected/Unavailable for devices), plus which one is currently targeted. Call this first if nothing is targeted or more than one candidate may exist.",
  {},
  async () => {
    const devices = await listTargets();
    return text({
      devices,
      target: peekTarget(),
      hint: devices.some((d) => d.state === "Unavailable")
        ? "Unavailable devices are paired but unreachable — connect by cable or put them on this Mac's network, and unlock them."
        : undefined,
    });
  },
);

server.tool(
  "select_device",
  "Target a simulator or a physical device (by UDID or unique name substring) for all subsequent tools, booting a shut-down simulator. Without this, a single booted simulator OR a single connected device is auto-targeted; one of each is ambiguous and must be chosen here.",
  {
    udid: z
      .string()
      .describe("UDID (or unique name substring) from list_devices"),
  },
  async ({ udid }) => {
    const d = await selectDevice(udid);
    return text(`Targeting ${d.name} ${d.iosVersion} (${d.udid}) [${d.kind}]`);
  },
);

/* ── Capture & inspection ─────────────────────────────────────────── */

server.tool(
  "inspect_screen",
  "Return the condensed accessibility tree of the current screen: every actionable element (button / input / text) with its label, id (React Native testID), and pre-computed tap coordinates in screenshot pixels. Use this instead of a screenshot to decide what to tap — far cheaper in tokens. If `sparse` is true, the screen is a canvas/game surface: fall back to `screenshot` + `tap_xy`.",
  {},
  async () => {
    const snap = await snapshot();
    const scale = await targetScale();
    return text({
      sparse: snap.sparse,
      rawNodeCount: snap.rawNodeCount,
      ungroupedCount: snap.ungroupedCount,
      elementCount: snap.elements.length,
      hint: snap.sparse
        ? "Tree is sparse (likely a game/canvas). Use `screenshot` then `tap_xy`."
        : "Each element is one logical target (rows grouped). Match by text/id/type, then `tap`.",
      elements: snap.elements.map((e) => toPixels(e, scale)),
    });
  },
);

server.tool(
  "find_element",
  "Check whether an element matching a selector is present on the current screen, returning its bounds and tap point (screenshot pixels). Returns found=false (not an error) when absent, with the closest on-screen labels.",
  selectorShape,
  async (sel) => {
    const res = await resolve(sel);
    const scale = await targetScale();
    return text({
      found: !!res.el,
      sparse: res.sparse,
      candidates: res.candidates,
      element: res.el ? toPixels(res.el, scale) : null,
      closestLabels: res.el ? undefined : res.nearest,
    });
  },
);

server.tool(
  "screenshot",
  "Capture the current viewport as a PNG saved to disk. Returns the file path, pixel dimensions, device scale, and orientation. Use for canvas apps or when you genuinely need to SEE the pixels; `tap_xy` takes coordinates read off this image as-is.",
  {},
  async () => {
    const frame = await screenshot(await getTarget());
    const scale = await targetScale();
    return text({
      ...frame,
      scale,
      orientation: frame.width > frame.height ? "landscape" : "portrait",
    });
  },
);

server.tool(
  "full_page_screenshot",
  "Capture a whole scrollable screen as a SEQUENCE of overlapping viewport screenshots (NOT stitched). Scrolls to the bottom, one PNG per viewport, stopping when the screen stops changing (tree-based detection; pixel fallback on sparse screens). Frames overlap on purpose — read them in order. For a single screen use `screenshot`.",
  {
    maxFrames: z
      .number()
      .optional()
      .describe("Safety cap on viewports captured (default 10)"),
  },
  async ({ maxFrames }) => {
    const r = await fullPageScreenshot(maxFrames ?? 10);
    return text({
      frameCount: r.frames.length,
      paths: r.frames.map((f) => f.path),
      reachedBottom: r.reachedBottom,
      bottomDetectedBy: r.detection,
      note: r.reachedBottom
        ? `Reached the bottom (detected via ${r.detection}). Frames overlap — read in order top-to-bottom.`
        : `Stopped at the frame cap (infinite scroll?). Frames overlap; read in order.`,
    });
  },
);

/* ── Element-aware interactions ───────────────────────────────────── */

server.tool(
  "tap",
  "Tap the element matching a selector (by text / id / type). Resolves the coordinate from a fresh UI tree, so you never pass pixels. Errors descriptively when no match — including the closest labels on screen and whether the screen was a canvas surface.",
  selectorShape,
  async (sel) => {
    const r = await tap(sel);
    return text({ tapped: clipLabel(r.label), at: { x: r.x, y: r.y } });
  },
);

server.tool(
  "tap_xy",
  "Low-level escape hatch: tap raw SCREENSHOT-PIXEL coordinates (converted to points internally). Use ONLY when inspect_screen reports sparse=true; otherwise prefer `tap`.",
  {
    x: z.number().describe("X in screenshot pixels"),
    y: z.number().describe("Y in screenshot pixels"),
  },
  async ({ x, y }) => {
    await tapXY(x, y);
    return text({ tapped: { x, y } });
  },
);

server.tool(
  "type_into",
  "Focus an input element (by selector) and type text into it via the on-screen keyboard. Optionally clears existing content first. Errors clearly if no keyboard appears (hardware-keyboard mode) or the field is secure.",
  {
    ...selectorShape,
    value: z.string().describe("Text to type"),
    clearFirst: z
      .boolean()
      .optional()
      .describe("Clear the field before typing (default false)"),
  },
  async ({ value, clearFirst, ...sel }) => {
    const r = await typeInto(sel, value, clearFirst ?? false);
    return text({ typedInto: clipLabel(r.label), value });
  },
);

server.tool(
  "wait_for",
  "Poll until an element matching the selector appears (or timeout). Use after an action that triggers async navigation/loading. Throws on timeout with the closest labels seen.",
  {
    ...selectorShape,
    timeoutMs: z.number().optional().describe("Max wait in ms (default 10000)"),
  },
  async ({ timeoutMs, ...sel }) => {
    const scale = await targetScale();
    const r = await waitFor(sel, timeoutMs ?? 10_000);
    return text({
      appeared: clipLabel(r.el.label) || r.el.id,
      at: {
        x: Math.round(r.el.center.x * scale),
        y: Math.round(r.el.center.y * scale),
      },
      elapsedMs: r.elapsedMs,
    });
  },
);

server.tool(
  "scroll_until",
  "Scroll the screen downward until an element matching the selector becomes visible, the bottom is reached (tree stops changing), or maxScrolls is exhausted. A measure-and-act loop — impossible as one command.",
  {
    ...selectorShape,
    maxScrolls: z.number().optional().describe("Max scroll steps (default 10)"),
  },
  async ({ maxScrolls, ...sel }) => {
    const r = await scrollUntil(sel, maxScrolls ?? 10);
    const scale = await targetScale();
    return text({
      found: r.found,
      scrolls: r.scrolls,
      reachedBottom: r.reachedBottom,
      element: r.el ? toPixels(r.el, scale) : undefined,
    });
  },
);

/* ── Device & test utilities ──────────────────────────────────────── */

server.tool(
  "current_app",
  "Return the foreground app's bundleId + pid, plus a `screenSignature` and best-guess `screenTitle` derived from the element tree. Single-window apps (RN/SwiftUI) never change bundleId between screens — compare `screenSignature` across calls to detect navigation.",
  {},
  async () => text(await currentApp()),
);

server.tool(
  "read_syslog",
  "Read recent log lines for one app, with crashes auto-flagged from .ips reports (reason + report path). On a SIMULATOR this is a historical window of the unified log (sinceSeconds back). On a PHYSICAL DEVICE, crash reports always work, but log lines need a USB cable and are captured LIVE for a few seconds (Apple requires root to read a device's past log) — the response says so when that happens. React Native JS errors surface in the lines.",
  {
    bundleId: z
      .string()
      .optional()
      .describe("Scope to this app's process (recommended)"),
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter on lines"),
    sinceSeconds: z
      .number()
      .optional()
      .describe("How far back to read (default 120)"),
    lines: z
      .number()
      .optional()
      .describe("Max lines returned (default and cap: 200)"),
  },
  async (opts) => text(await readSyslog(await getTarget(), opts)),
);

server.tool(
  "reset_app",
  "Restore an app to a fresh first-run state AND relaunch it. SIMULATOR: terminate → wipe the data container's Documents/Library/tmp → launch, or uninstall + install with reinstall=true (requires appPath) for state in Keychain/app-group containers. PHYSICAL DEVICE: appPath is REQUIRED — a device container cannot be wiped in place, so the reset is always uninstall + install + launch.",
  {
    bundleId: z.string().describe("App bundle id, e.g. com.example.app"),
    reinstall: z
      .boolean()
      .optional()
      .describe("Uninstall + reinstall instead of wiping data (default false)"),
    appPath: z
      .string()
      .optional()
      .describe("Path to the .app bundle — required with reinstall"),
  },
  async ({ bundleId, reinstall, appPath }) =>
    text(await resetApp(await getTarget(), bundleId, { reinstall, appPath })),
);

/* ── Regression & capture tools ───────────────────────────────────── */

server.tool(
  "visual_diff",
  "Compare two screenshots and report WHAT changed: a percentage, a verdict (identical/minor/changed), and the changed regions as boxes in screenshot pixels, plus an annotated image. Omit `after` to capture the current screen and compare it against `before` — the usual 'did my change move anything?' check. Differently sized inputs are compared over their shared area, never stretched.",
  {
    before: z.string().describe("Path to the baseline PNG (from `screenshot`)"),
    after: z
      .string()
      .optional()
      .describe("Path to the comparison PNG; omit to capture the screen now"),
    threshold: z
      .number()
      .optional()
      .describe("Per-channel difference to ignore as noise (default 10 of 255)"),
  },
  async ({ before, after, threshold }) => {
    const afterPath = after ?? (await screenshot(await getTarget())).path;
    const r = await visualDiff(before, afterPath, threshold);
    return text({ ...r, before, after: afterPath });
  },
);

server.tool(
  "record_screen",
  "Record the screen while you drive the app with other tools: call with action='start', perform the flow, then action='stop' to get the finished mp4. One recording per target; it auto-stops at maxSeconds so a forgotten recording cannot fill the disk. Simulators use the native h264 encoder; devices re-encode WDA's MJPEG stream (lower fidelity, reported in the response).",
  {
    action: z.enum(["start", "stop"]).describe("Begin or finish a recording"),
    name: z
      .string()
      .optional()
      .describe("Base filename for the mp4 (start only; default 'recording')"),
    maxSeconds: z
      .number()
      .optional()
      .describe("Auto-stop after this long (start only; default 120, cap 600)"),
  },
  async ({ action, name, maxSeconds }) => {
    const target = await getTarget();
    return text(
      action === "start"
        ? await startRecording(target, name, maxSeconds)
        : await stopRecording(target),
    );
  },
);

/* ── Boot ─────────────────────────────────────────────────────────── */

killOrphanWda().catch(() => {}); // best-effort sweep, never blocks startup
// A half-written mp4 is worthless; finalize recordings before we go.
for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
  process.on(signal, stopAllRecordings);
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ios-mcp server running on stdio");
