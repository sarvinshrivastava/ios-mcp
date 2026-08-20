/**
 * visual_diff geometry, on synthetic images with a KNOWN changed rectangle.
 *
 * The point of these is that the reported boxes must actually contain the thing
 * that moved — a percentage alone can be right while the regions point nowhere.
 */

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { visualDiff } from "../src/visualdiff.ts";

const W = 320;
const H = 640;
let dir: string;

/** A grey canvas with an optional filled rectangle. */
async function makeImage(
  name: string,
  rect?: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const path = join(dir, name);
  const svg = rect
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#808080"/>` +
      `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="#000000"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#808080"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ios-mcp-vd-"));
  process.env.IOS_MCP_OUTPUT_DIR = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("visualDiff", () => {
  test("identical images report zero change and no regions", async () => {
    const a = await makeImage("flat-a.png");
    const b = await makeImage("flat-b.png");
    const r = await visualDiff(a, b);
    expect(r.diffPct).toBe(0);
    expect(r.verdict).toBe("identical");
    expect(r.changedRegions).toEqual([]);
  });

  test("a changed rectangle is located, not just counted", async () => {
    const before = await makeImage("before.png");
    const after = await makeImage("after.png", { x: 64, y: 128, w: 96, h: 96 });
    const r = await visualDiff(before, after);

    expect(r.verdict).toBe("changed");
    // 96×96 of 320×640 ≈ 4.5%
    expect(r.diffPct).toBeGreaterThan(3);
    expect(r.diffPct).toBeLessThan(6);
    expect(r.changedRegions.length).toBeGreaterThan(0);

    // The reported box must cover the rectangle's centre.
    const [region] = r.changedRegions;
    expect(region.x).toBeLessThanOrEqual(112);
    expect(region.y).toBeLessThanOrEqual(176);
    expect(region.x + region.w).toBeGreaterThanOrEqual(112);
    expect(region.y + region.h).toBeGreaterThanOrEqual(176);
  });

  test("two separate changes merge into two regions, not one big box", async () => {
    const before = await makeImage("two-before.png");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#808080"/>` +
      `<rect x="16" y="16" width="64" height="64" fill="#000"/>` +
      `<rect x="220" y="520" width="64" height="64" fill="#000"/></svg>`;
    const after = join(dir, "two-after.png");
    await sharp(Buffer.from(svg)).png().toFile(after);

    const r = await visualDiff(before, after);
    expect(r.changedRegions.length).toBe(2);
    // Distinct corners: the boxes must not have been fused across the canvas.
    const [first, second] = r.changedRegions;
    expect(Math.abs(first.y - second.y)).toBeGreaterThan(200);
  });

  test("threshold suppresses low-amplitude noise", async () => {
    const before = await makeImage("noise-before.png");
    // #858585 vs #808080 — a 5/255 shift, below the default threshold of 10.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#808080"/>` +
      `<rect x="32" y="32" width="128" height="128" fill="#858585"/></svg>`;
    const after = join(dir, "noise-after.png");
    await sharp(Buffer.from(svg)).png().toFile(after);

    expect((await visualDiff(before, after)).diffPct).toBe(0);
    // Same pixels, threshold lowered → the change becomes visible.
    expect((await visualDiff(before, after, 2)).diffPct).toBeGreaterThan(0);
  });

  test("mismatched sizes compare the shared area and say so", async () => {
    const before = await makeImage("small-before.png");
    const tall = join(dir, "tall-after.png");
    await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 200}">` +
          `<rect width="${W}" height="${H + 200}" fill="#808080"/></svg>`,
      ),
    )
      .png()
      .toFile(tall);

    const r = await visualDiff(before, tall);
    expect(r.comparedSize).toEqual({ width: W, height: H });
    expect(r.sizeMismatch).toContain("shared");
    expect(r.diffPct).toBe(0); // the shared area really is identical
  });

  test("the annotated diff image is written and readable", async () => {
    const before = await makeImage("ann-before.png");
    const after = await makeImage("ann-after.png", { x: 100, y: 100, w: 80, h: 80 });
    const r = await visualDiff(before, after);
    const meta = await sharp(r.diffImagePath).metadata();
    expect(meta.width).toBe(W);
    expect(meta.height).toBe(H);
  });
});
