/**
 * backend.ts — one API over two very different toolchains.
 *
 * Simulators are driven by `simctl`, devices by `devicectl`, and the two are
 * not feature-equal: a device has no data-container wipe and no root-free
 * unified log. Rather than pretend, this layer routes each operation to the
 * backend that can do it and returns an honest error where a backend genuinely
 * cannot — the difference is documented in the tool descriptions, not hidden
 * behind a weaker silent fallback.
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as sim from "./simctl.ts";
import * as dev from "./devicectl.ts";
import * as simUtils from "./device.ts";
import { crashProcess, crashReason, crashTimestamp, parseIps, type CrashReport } from "./crash.ts";
import { outputDir } from "./screenshot.ts";
import { requireDeviceCtlId, type Target } from "./target.ts";

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

export async function launchApp(t: Target, bundleId: string): Promise<number> {
  return t.kind === "sim"
    ? sim.launchApp(t.udid, bundleId)
    : dev.launchApp(requireDeviceCtlId(t), bundleId);
}

export async function terminateApp(t: Target, bundleId: string): Promise<void> {
  return t.kind === "sim"
    ? sim.terminateApp(t.udid, bundleId)
    : dev.terminateApp(requireDeviceCtlId(t), bundleId);
}

/** The executable name the unified log uses for an app (needed to filter logs). */
export async function executableName(t: Target, bundleId: string): Promise<string> {
  if (t.kind === "sim") return simUtils.executableName(t.udid, bundleId);
  const apps = await dev.listApps(requireDeviceCtlId(t));
  const app = apps.find((a) => a.bundleId === bundleId);
  if (!app?.executable) {
    throw new Error(
      `${bundleId} is not installed on ${t.name}` +
        (apps.length ? ` (installed: ${apps.map((a) => a.bundleId).join(", ")})` : ""),
    );
  }
  return app.executable;
}

// ---------------------------------------------------------------------------
// Logs & crashes
// ---------------------------------------------------------------------------

export interface SyslogResult {
  lines: string[];
  crashes: CrashReport[];
  /** Present when a backend could not deliver part of the answer, and why. */
  note?: string;
}

/**
 * Read recent log lines and flag crashes.
 *
 * Simulator: the full v1 behavior — a time-bounded, app-scoped unified-log
 * window plus crash reports from DiagnosticReports.
 *
 * Device: crash reports always (CoreDevice serves them over Wi-Fi with no
 * privileges), but log LINES only when the phone is on USB. `log collect
 * --device-udid` refuses without root — verified: "Must be root to collect logs
 * from attached device" — so the cable-only `idevicesyslog` is the sole
 * unprivileged source. Without it the result says so instead of looking empty.
 */
export async function readSyslog(
  t: Target,
  opts: simUtils.SyslogOptions = {},
): Promise<SyslogResult> {
  if (t.kind === "sim") return simUtils.readSyslog(t.udid, opts);

  const cap = Math.min(Math.max(1, opts.lines ?? 200), 200);
  const sinceSeconds = Math.max(1, opts.sinceSeconds ?? 120);
  const executable = opts.bundleId
    ? await executableName(t, opts.bundleId)
    : undefined;

  const crashes = opts.bundleId
    ? await deviceCrashes(t, executable!, sinceSeconds)
    : [];

  const usb = await dev.usbmuxSees(t.udid);
  if (!usb) {
    return {
      lines: [],
      crashes,
      note:
        "Log lines are unavailable: this device is reachable over the network, not USB. " +
        "`log collect --device-udid` needs root, so the only unprivileged source is `idevicesyslog`, " +
        "which requires a data cable. Crash reports above were still read over the network. " +
        "Connect the cable for line-level logs.",
    };
  }

  const lines = await dev.syslogLines(t.udid, {
    process: executable,
    filter: opts.filter,
    seconds: Math.min(sinceSeconds, 30),
    lines: cap,
  });
  return {
    lines,
    crashes,
    note:
      "Device logs are captured LIVE for a few seconds (usbmux gives no history) — " +
      "trigger the behavior while this runs, or read the crash reports for past failures.",
  };
}

/** Crash reports for one process, pulled off the device and parsed locally. */
async function deviceCrashes(
  t: Target,
  executable: string,
  sinceSeconds: number,
): Promise<CrashReport[]> {
  const id = requireDeviceCtlId(t);
  const cutoff = Date.now() - sinceSeconds * 1000;
  const files = await dev.listCrashFiles(id).catch(() => []);

  // Match on filename before copying anything: reports are named
  // "<Executable>-2026-08-20-134500.ips", and the device keeps hundreds.
  const mine = files
    .filter((f) => f.name.endsWith(".ips") || f.name.includes(".ips"))
    .filter((f) => f.name.split("/").pop()!.startsWith(executable))
    .filter((f) => !f.modifiedAt || f.modifiedAt.getTime() >= cutoff)
    .sort((a, b) => (a.modifiedAt?.getTime() ?? 0) - (b.modifiedAt?.getTime() ?? 0))
    // A crash storm shouldn't turn one tool call into a hundred file copies.
    .slice(-5);

  const dir = join(outputDir(), "crashes");
  await mkdir(dir, { recursive: true });

  const crashes: CrashReport[] = [];
  for (const file of mine) {
    const local = await dev.copyCrashFile(id, file.name, dir).catch(() => null);
    if (!local) continue;
    const parsed = parseIps(await Bun.file(local).text().catch(() => ""));
    const procMatches = crashProcess(parsed);
    if (procMatches && procMatches !== executable) continue;
    const mtime = file.modifiedAt?.getTime() ?? (await stat(local)).mtimeMs;
    crashes.push({
      path: local,
      reason: crashReason(parsed),
      at: crashTimestamp(parsed.header, mtime),
    });
  }
  return crashes;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetResult {
  cleared: boolean;
  reinstalled: boolean;
  pid: number;
}

/**
 * Restore an app to first-run state and relaunch it.
 *
 * A simulator gets the fast path (wipe the data container). A device CANNOT:
 * `devicectl device copy` has only `to`/`from` and no delete verb, so there is
 * no supported way to empty a container in place — reinstalling is the only
 * real reset, and it needs the .app/.ipa. Asking without one is an error that
 * says why, rather than a terminate-and-relaunch that clears nothing.
 */
export async function resetApp(
  t: Target,
  bundleId: string,
  opts: simUtils.ResetAppOptions = {},
): Promise<ResetResult> {
  if (t.kind === "sim") return simUtils.resetApp(t.udid, bundleId, opts);

  const id = requireDeviceCtlId(t);
  if (!opts.appPath) {
    throw new Error(
      `reset_app on a physical device requires appPath: there is no supported way to wipe an app's ` +
        `data container on a device (devicectl copy has no delete verb), so a real reset means ` +
        `uninstall + install. Pass the .app/.ipa for ${bundleId}, or use the simulator for ` +
        `container-only resets.`,
    );
  }
  await dev.terminateApp(id, bundleId);
  await dev.uninstallApp(id, bundleId);
  await dev.installApp(id, opts.appPath);
  const pid = await dev.launchApp(id, bundleId);
  return { cleared: true, reinstalled: true, pid };
}
