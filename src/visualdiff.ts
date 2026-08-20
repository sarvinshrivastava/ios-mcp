/**
 * visualdiff.ts — "did anything on screen actually change?", answered in
 * numbers and boxes instead of two images an agent has to eyeball.
 *
 * Why a tool: comparing screenshots is exactly the kind of work an agent is bad
 * at and a loop is good at. It condenses (one percentage + a handful of boxes
 * instead of two full images) and it composes (capture, align, compare,
 * annotate). Everything it reports is in SCREENSHOT PIXELS, like every other
 * coordinate in this server.
 */

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { outputDir } from "./screenshot.ts";

/** Cell grid used to turn changed pixels into regions worth naming. */
const GRID = 16;
/** Per-channel difference below this is compression noise, not a change. */
const DEFAULT_THRESHOLD = 10;
/** Never return more boxes than an agent can act on. */
const MAX_REGIONS = 12;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualDiffResult {
  /** Share of compared pixels that differ beyond the threshold, 0–100. */
  diffPct: number;
  /** "identical" | "minor" | "changed" — so callers can branch without a float. */
  verdict: "identical" | "minor" | "changed";
  /** Changed areas, largest first, in screenshot pixels. */
  changedRegions: Region[];
  /** The `after` image with changed regions outlined. */
  diffImagePath: string;
  /** Size actually compared (the smaller of the two, when they differ). */
  comparedSize: { width: number; height: number };
  /** Set when the inputs were not the same size — resolution/orientation drift. */
  sizeMismatch?: string;
}

/**
 * Compare two PNGs.
 *
 * Images of different sizes are compared over their common top-left area rather
 * than stretched: a rotated or differently-scaled pair would otherwise report a
 * huge fake difference. The mismatch is reported, never silently absorbed.
 */
export async function visualDiff(
  beforePath: string,
  afterPath: string,
  threshold = DEFAULT_THRESHOLD,
): Promise<VisualDiffResult> {
  const [beforeMeta, afterMeta] = await Promise.all([
    sharp(beforePath).metadata(),
    sharp(afterPath).metadata(),
  ]);
  if (!beforeMeta.width || !beforeMeta.height || !afterMeta.width || !afterMeta.height) {
    throw new Error("Both inputs must be readable images");
  }

  const width = Math.min(beforeMeta.width, afterMeta.width);
  const height = Math.min(beforeMeta.height, afterMeta.height);
  const sizeMismatch =
    beforeMeta.width !== afterMeta.width || beforeMeta.height !== afterMeta.height
      ? `before is ${beforeMeta.width}×${beforeMeta.height}, after is ${afterMeta.width}×${afterMeta.height} — ` +
        `compared the shared ${width}×${height} area only`
      : undefined;

  // Greyscale raw bytes: one channel is enough to locate change, and it keeps
  // a full-screen comparison cheap.
  const extract = { left: 0, top: 0, width, height };
  const [a, b] = await Promise.all([
    sharp(beforePath).extract(extract).greyscale().raw().toBuffer(),
    sharp(afterPath).extract(extract).greyscale().raw().toBuffer(),
  ]);

  const cellW = Math.ceil(width / GRID);
  const cellH = Math.ceil(height / GRID);
  const changedCells: boolean[][] = Array.from({ length: GRID }, () =>
    Array(GRID).fill(false),
  );
  // A cell counts as changed only when enough of it moved — a single stray
  // pixel is noise, and antialiasing shifts a few pixels on every render.
  const cellPixelCounts: number[][] = Array.from({ length: GRID }, () =>
    Array(GRID).fill(0),
  );

  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const cy = Math.min(GRID - 1, Math.floor(y / cellH));
    for (let x = 0; x < width; x++) {
      if (Math.abs(a[row + x] - b[row + x]) <= threshold) continue;
      changedPixels++;
      cellPixelCounts[cy][Math.min(GRID - 1, Math.floor(x / cellW))]++;
    }
  }

  const minCellPixels = Math.max(16, Math.floor((cellW * cellH) / 100));
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      changedCells[cy][cx] = cellPixelCounts[cy][cx] >= minCellPixels;
    }
  }

  const diffPct = (changedPixels / (width * height)) * 100;
  const changedRegions = mergeCells(changedCells, cellW, cellH, width, height);
  const diffImagePath = await annotate(afterPath, changedRegions);

  return {
    diffPct: Number(diffPct.toFixed(3)),
    verdict: diffPct === 0 ? "identical" : diffPct < 0.5 ? "minor" : "changed",
    changedRegions,
    diffImagePath,
    comparedSize: { width, height },
    ...(sizeMismatch ? { sizeMismatch } : {}),
  };
}

/**
 * Flood-fill adjacent changed cells into rectangles.
 *
 * Per-cell output would be up to 256 boxes describing one moved button; a
 * connected-component pass gives "these three areas changed", which is what a
 * caller can actually reason about.
 */
function mergeCells(
  cells: boolean[][],
  cellW: number,
  cellH: number,
  width: number,
  height: number,
): Region[] {
  const seen = Array.from({ length: GRID }, () => Array(GRID).fill(false));
  const regions: Region[] = [];

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!cells[y][x] || seen[y][x]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [[y, x]];
      seen[y][x] = true;
      while (stack.length) {
        const [cy, cx] = stack.pop()!;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const ny = cy + dy;
          const nx = cx + dx;
          if (ny < 0 || nx < 0 || ny >= GRID || nx >= GRID) continue;
          if (!cells[ny][nx] || seen[ny][nx]) continue;
          seen[ny][nx] = true;
          stack.push([ny, nx]);
        }
      }
      regions.push({
        x: minX * cellW,
        y: minY * cellH,
        w: Math.min(width - minX * cellW, (maxX - minX + 1) * cellW),
        h: Math.min(height - minY * cellH, (maxY - minY + 1) * cellH),
      });
    }
  }

  return regions.sort((p, q) => q.w * q.h - p.w * p.h).slice(0, MAX_REGIONS);
}

/** Write `after` with the changed regions outlined, for a human to glance at. */
async function annotate(afterPath: string, regions: Region[]): Promise<string> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const out = join(
    dir,
    `visualdiff-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  );
  const { width, height } = await sharp(afterPath).metadata();

  const rects = regions
    .map(
      (r) =>
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" ` +
        `fill="none" stroke="#ff2d55" stroke-width="4"/>`,
    )
    .join("");
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`,
  );

  await sharp(afterPath)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toFile(out);
  return out;
}
