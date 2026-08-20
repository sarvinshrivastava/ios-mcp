/**
 * screenshot.ts — single-viewport capture, for simulators and real devices.
 *
 * Capture goes through WDA's `/screenshot` on BOTH backends. That is the whole
 * point: a physical device has no `simctl io`, and one shared path cannot drift
 * from itself. `simctl io` survives only as a simulator fallback for the case
 * where WDA itself cannot produce an image.
 *
 * Captures go to disk (never inline base64) under IOS_MCP_OUTPUT_DIR, and the
 * caller gets the path plus the PNG's REAL pixel dimensions read back via
 * sharp. On iOS the screenshot is in pixels (points × scale, scale 2–3) while
 * WDA's tree/actions are in points — `scale` and `orientation` are injected by
 * the integration layer from WDA, not faked here.
 *
 * Full-page capture (scroll + repeat) needs WDA-driven swipes and tree-based
 * bottom detection, which live with the actions/uitree layers. This module
 * only provides the reusable single-frame primitive (`captureFrame`) that the
 * full-page loop calls once per scroll step; frames overlap by design and are
 * never stitched (android-mcp learned that the hard way — sticky bars,
 * floating buttons, and autoplaying media corrupt every seam).
 */

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simctl } from "./simctl.ts";
import { ensureWda } from "./wda.ts";
import type { Target } from "./target.ts";

/** Where screenshots land. Created on demand. */
export function outputDir(): string {
  return (
    process.env.IOS_MCP_OUTPUT_DIR ||
    join(process.env.TMPDIR || tmpdir(), "ios-mcp")
  );
}

export interface Frame {
  /** Absolute path of the PNG on disk. */
  path: string;
  /** Actual pixel width of the PNG (points × device scale). */
  width: number;
  /** Actual pixel height of the PNG. */
  height: number;
}

// Monotonic suffix so two captures inside the same millisecond (full-page
// loops are fast) never collide on filename.
let frameSeq = 0;

/**
 * Capture the current viewport to a timestamped PNG.
 *
 * The reusable primitive: `screenshot` calls it once; the full-page loop
 * (integration layer) calls it once per scroll step with a `tag` like
 * "frame-3" so a sequence sorts and reads naturally on disk.
 */
export async function captureFrame(
  target: Target,
  tag?: string,
): Promise<Frame> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = (frameSeq++).toString(36).padStart(2, "0");
  const name = tag
    ? `screenshot-${stamp}-${seq}-${tag}.png`
    : `screenshot-${stamp}-${seq}.png`;
  const path = join(dir, name);

  try {
    const wda = await ensureWda(target);
    await Bun.write(path, await wda.screenshot());
  } catch (err) {
    if (target.kind === "device") throw err; // no second route exists
    // Simulator fallback: WDA can fail (session wedged, runner restarting)
    // while `simctl io` still works, and v1 shipped on that path.
    await simctl(target.udid, ["io", target.udid, "screenshot", path]);
  }

  // Read the REAL dimensions off the file — correct in landscape too, where a
  // device-catalog lookup would report the swapped portrait dims.
  const meta = await sharp(path).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`Screenshot at ${path} is not a readable PNG`);
  }
  return { path, width: meta.width, height: meta.height };
}

/**
 * Single-viewport screenshot. Returns the file path + pixel dimensions.
 * The `screenshot` MCP tool wraps this and adds `{scale, orientation}` from
 * the WDA session before returning to the agent.
 */
export async function screenshot(target: Target): Promise<Frame> {
  return captureFrame(target);
}
