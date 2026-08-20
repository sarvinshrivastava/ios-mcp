/**
 * recorder.ts — screen recording as ONE resource with two edges.
 *
 * A recording is inherently stateful: an agent starts it, drives the app with
 * other tools, then stops it. That is why this is `record_screen({action})`
 * rather than a blocking "record for N seconds" call — the useful recording is
 * of a flow, and a flow is made of other tool calls.
 *
 * Backends differ in fidelity, and the difference is reported rather than
 * hidden:
 *   - simulator: `simctl io recordVideo`, the platform's native h264 encoder;
 *   - device: WDA's MJPEG stream re-encoded by ffmpeg, which is lower fidelity
 *     and frame-rate limited, because no unprivileged device-side encoder is
 *     reachable from here.
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureWda } from "./wda.ts";
import { outputDir } from "./screenshot.ts";
import type { Target } from "./target.ts";

/** WDA's MJPEG server port on the target (its own default). */
const MJPEG_PORT = 9100;
/** Recordings stop themselves so a forgotten one cannot fill the disk. */
const DEFAULT_MAX_SECONDS = 120;
const HARD_MAX_SECONDS = 600;

interface Recording {
  udid: string;
  kind: Target["kind"];
  path: string;
  child: ReturnType<typeof Bun.spawn>;
  startedAt: number;
  /** Auto-stop timer; cleared on an explicit stop. */
  timer: ReturnType<typeof setTimeout>;
  source: "simctl recordVideo (h264)" | "WDA MJPEG → ffmpeg (h264)";
}

/** One recording per target — recording two things at once has no meaning. */
const active = new Map<string, Recording>();

export interface StartResult {
  path: string;
  maxSeconds: number;
  source: string;
  note?: string;
}

export async function startRecording(
  target: Target,
  name?: string,
  maxSeconds = DEFAULT_MAX_SECONDS,
): Promise<StartResult> {
  const existing = active.get(target.udid);
  if (existing) {
    throw new Error(
      `Already recording ${target.name} to ${existing.path} ` +
        `(started ${Math.round((Date.now() - existing.startedAt) / 1000)}s ago). ` +
        "Stop that first with record_screen({action:'stop'}).",
    );
  }

  const cap = Math.min(Math.max(1, maxSeconds), HARD_MAX_SECONDS);
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = (name || "recording").replace(/\.(mp4|mov)$/i, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${base}-${stamp}.mp4`);

  const { child, source, note } =
    target.kind === "sim"
      ? await startSimRecording(target, path)
      : await startDeviceRecording(target, path);

  const rec: Recording = {
    udid: target.udid,
    kind: target.kind,
    path,
    child,
    startedAt: Date.now(),
    source,
    timer: setTimeout(() => {
      // Fire and forget: the auto-stop exists to bound the file, and whoever
      // calls stop() afterwards still gets the finished path.
      void stopRecording(target).catch(() => {});
    }, cap * 1000),
  };
  active.set(target.udid, rec);
  return { path, maxSeconds: cap, source, note };
}

async function startSimRecording(target: Target, path: string) {
  const child = Bun.spawn(
    ["xcrun", "simctl", "io", target.udid, "recordVideo", "--codec", "h264", "--force", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  child.unref();
  await Bun.sleep(300);
  if (child.exitCode !== null) {
    const err = (await new Response(child.stderr).text()).trim();
    throw new Error(`simctl recordVideo exited immediately: ${err || `code ${child.exitCode}`}`);
  }
  return { child, source: "simctl recordVideo (h264)" as const, note: undefined };
}

/**
 * Device recording rides WDA's MJPEG stream.
 *
 * The stream lives on the same host WDA answers on — a localhost tunnel port or
 * the phone's own address — so the endpoint is derived from the live client
 * rather than assumed. A session must exist first: WDA only serves MJPEG frames
 * while a session is active.
 */
async function startDeviceRecording(target: Target, path: string) {
  const wda = await ensureWda(target);
  await wda.ensureSession();
  const host = new URL(wda.baseUrl).hostname;
  const url = `http://${host}:${MJPEG_PORT}`;

  const child = Bun.spawn(
    ["ffmpeg", "-y", "-f", "mjpeg", "-i", url, "-c:v", "h264", "-pix_fmt", "yuv420p", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  child.unref();
  await Bun.sleep(1_000); // ffmpeg needs a moment to connect and start writing
  if (child.exitCode !== null) {
    const err = (await new Response(child.stderr).text()).trim().split("\n").slice(-3).join(" ");
    throw new Error(
      `ffmpeg could not read WDA's MJPEG stream at ${url}: ${err || `exit ${child.exitCode}`}. ` +
        "The stream only runs while a WDA session is alive.",
    );
  }
  return {
    child,
    source: "WDA MJPEG → ffmpeg (h264)" as const,
    note:
      "Device recording re-encodes WDA's MJPEG stream: lower frame rate and fidelity than a " +
      "simulator's native encoder. Expect a usable flow recording, not a pixel-accurate capture.",
  };
}

export interface StopResult {
  path: string;
  durationMs: number;
  sizeBytes: number;
  source: string;
}

export async function stopRecording(target: Target): Promise<StopResult> {
  const rec = active.get(target.udid);
  if (!rec) {
    throw new Error(
      `Not recording ${target.name}. Start one with record_screen({action:'start'}).`,
    );
  }
  active.delete(target.udid);
  clearTimeout(rec.timer);

  // SIGINT, not SIGTERM: both simctl and ffmpeg finalize the container on
  // interrupt and truncate it on terminate — the file is unplayable otherwise.
  rec.child.kill("SIGINT");
  await Promise.race([rec.child.exited, Bun.sleep(10_000)]);
  if (rec.child.exitCode === null) rec.child.kill("SIGKILL");

  const size = await stat(rec.path)
    .then((s) => s.size)
    .catch(() => 0);
  if (size === 0) {
    throw new Error(
      `Recording produced no data at ${rec.path} — the encoder was interrupted before writing a frame.`,
    );
  }
  return {
    path: rec.path,
    durationMs: Date.now() - rec.startedAt,
    sizeBytes: size,
    source: rec.source,
  };
}

/** Anything still recording when the server exits, for teardown. */
export function stopAllRecordings(): void {
  for (const rec of active.values()) {
    clearTimeout(rec.timer);
    rec.child.kill("SIGINT");
  }
  active.clear();
}
