/**
 * devicectl.ts — the physical-device counterpart to simctl.ts.
 *
 * `xcrun devicectl` is CoreDevice's CLI: the supported way to talk to a real
 * iPhone on Xcode 15+. Two things shape this module:
 *
 *   1. devicectl's own help states that a JSON file written with
 *      `--json-output` is the ONLY supported machine-readable interface — the
 *      human table is explicitly not one. So every call here goes through a
 *      temp JSON file, never through stdout scraping.
 *   2. It replaces simctl, not adb: there is no `wipe`, and `copy` has only
 *      `to`/`from` (no delete) — which is why `reset_app` on a device must
 *      reinstall rather than empty a container.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xcrun } from "./simctl.ts";

export interface PhysicalDevice {
  /** User-visible device name ("Himanshu's iPhone"). */
  name: string;
  /** The real hardware UDID (what iproxy/log/profiles use). */
  udid: string;
  /** devicectl's OWN identifier — different from the UDID, and what -d wants. */
  deviceCtlId: string;
  iosVersion: string;
  /** "iPhone" / "iPad" — devicectl also lists paired Macs and Watches. */
  deviceType: string;
  /** "wired" | "localNetwork" | null (unknown/not currently attached). */
  transport: string | null;
  /** CoreDevice tunnel: "connected" | "disconnected" | "unavailable". */
  tunnelState: string;
  pairingState: string;
  /** Developer Mode must be enabled to run XCUITest (i.e. WDA) at all. */
  developerMode: string;
  ddiServicesAvailable: boolean;
  /** Usable as a target now? False for devices CoreDevice can't reach. */
  available: boolean;
}

/** Run a devicectl subcommand and parse its --json-output payload. */
async function json<T = any>(
  args: string[],
  timeoutMs = 60_000,
): Promise<T> {
  const out = join(tmpdir(), `ios-mcp-devicectl-${process.pid}-${seq++}.json`);
  try {
    const { stderr, stdout, exitCode } = await xcrun(
      ["devicectl", ...args, "--json-output", out],
      timeoutMs,
    );
    const payload = await Bun.file(out)
      .json()
      .catch(() => null);
    if (payload === null) {
      throw new Error(
        `devicectl ${args.join(" ")} produced no JSON (exit ${exitCode}): ${
          stderr.trim() || stdout.trim() || "no output"
        }`,
      );
    }
    // devicectl writes JSON even for failures — surface its own error text.
    if (exitCode !== 0) {
      const err =
        payload?.error?.userInfo?.NSLocalizedDescription?.string ??
        payload?.error?.localizedDescription ??
        stderr.trim();
      throw new Error(`devicectl ${args.join(" ")} failed (exit ${exitCode}): ${err}`);
    }
    return payload.result as T;
  } finally {
    await rm(out, { force: true });
  }
}
let seq = 0;

/** Every iOS device CoreDevice knows about, reachable or not. */
export async function listDevices(): Promise<PhysicalDevice[]> {
  return parseDevices(await json<{ devices: any[] }>(["list", "devices"]));
}

/**
 * Map `devicectl list devices` JSON onto PhysicalDevice. Split out from the
 * subprocess call so the field plumbing is testable against a fixture — the
 * shape is Apple's and undocumented, so a silent rename is the likely breakage.
 */
export function parseDevices(result: { devices?: any[] }): PhysicalDevice[] {
  return (result.devices ?? [])
    .filter((d) => d.hardwareProperties?.platform === "iOS")
    .map((d) => {
      const conn = d.connectionProperties ?? {};
      return {
        name: d.deviceProperties?.name ?? "(unnamed)",
        udid: d.hardwareProperties?.udid ?? "",
        deviceCtlId: d.identifier ?? "",
        iosVersion: d.deviceProperties?.osVersionNumber ?? "",
        deviceType: d.hardwareProperties?.deviceType ?? "",
        transport: conn.transportType ?? null,
        tunnelState: conn.tunnelState ?? "unknown",
        pairingState: conn.pairingState ?? "unknown",
        developerMode: d.deviceProperties?.developerModeStatus ?? "unknown",
        ddiServicesAvailable: d.deviceProperties?.ddiServicesAvailable === true,
        // "unavailable" is CoreDevice's own word for "I can't reach this".
        available: (conn.tunnelState ?? "unknown") !== "unavailable",
      };
    })
    .filter((d) => d.udid);
}

/**
 * Is the screen unlocked? WDA cannot drive a locked device, and a locked one
 * fails in confusing ways (blank trees, stalled taps), so callers check first.
 */
export async function lockState(
  deviceCtlId: string,
): Promise<{ passcodeRequired: boolean; unlockedSinceBoot: boolean }> {
  const r = await json<any>(["device", "info", "lockState", "-d", deviceCtlId], 30_000);
  return {
    passcodeRequired: r?.passcodeRequired === true,
    unlockedSinceBoot: r?.unlockedSinceBoot === true,
  };
}

export interface InstalledApp {
  bundleId: string;
  name: string;
  version: string;
  /** Executable name — what the unified log calls the process. */
  executable: string;
}

/** Apps installed on the device (the device analogue of `simctl appinfo`). */
export async function listApps(deviceCtlId: string): Promise<InstalledApp[]> {
  const r = await json<{ apps: any[] }>(
    ["device", "info", "apps", "-d", deviceCtlId],
    90_000,
  );
  return (r.apps ?? []).map((a) => ({
    bundleId: a.bundleIdentifier ?? "",
    name: a.name ?? "",
    version: a.version ?? "",
    // "/private/var/containers/Bundle/Application/…/Nidra.app/Nidra"
    executable: (a.url ?? "").replace(/\/$/, "").split("/").pop()?.replace(/\.app$/, "") ?? "",
  }));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/** Launch an app and return its pid. */
export async function launchApp(
  deviceCtlId: string,
  bundleId: string,
): Promise<number> {
  const r = await json<any>(
    ["device", "process", "launch", "--terminate-existing", "-d", deviceCtlId, bundleId],
    120_000,
  );
  const pid = r?.process?.processIdentifier;
  if (typeof pid !== "number") {
    throw new Error(`devicectl launched ${bundleId} but reported no pid`);
  }
  return pid;
}

/** Terminate every running instance of an app. Tolerates "not running". */
export async function terminateApp(
  deviceCtlId: string,
  bundleId: string,
): Promise<void> {
  // There is no terminate-by-bundle-id; find the pid first, then signal it.
  const r = await json<{ runningProcesses?: any[] }>(
    ["device", "info", "processes", "-d", deviceCtlId, "--filter", `executable.path CONTAINS '${bundleId}'`],
    90_000,
  ).catch(() => ({ runningProcesses: [] as any[] }));
  for (const proc of r.runningProcesses ?? []) {
    const pid = proc.processIdentifier;
    if (typeof pid !== "number") continue;
    await json(["device", "process", "signal", "-d", deviceCtlId, "--signal", "SIGKILL", "--pid", String(pid)], 60_000).catch(
      () => {},
    );
  }
}

export async function installApp(deviceCtlId: string, appPath: string): Promise<void> {
  await json(["device", "install", "app", "-d", deviceCtlId, appPath], 600_000);
}

export async function uninstallApp(deviceCtlId: string, bundleId: string): Promise<void> {
  await json(["device", "uninstall", "app", "-d", deviceCtlId, bundleId], 180_000);
}

// ---------------------------------------------------------------------------
// Crash reports
// ---------------------------------------------------------------------------

export interface DeviceFile {
  /** Path relative to the domain root, e.g. "Retired/Nidra-2026-08-20-…ips". */
  name: string;
  sizeBytes: number;
  modifiedAt: Date | null;
}

/**
 * List files in the device's crash-report domain.
 *
 * This is the one crash source that works with no cable and no root, which is
 * why it carries device crash reporting on its own (see readSyslog: the unified
 * log itself needs either USB or root).
 */
export async function listCrashFiles(deviceCtlId: string): Promise<DeviceFile[]> {
  const r = await json<{ files?: any[] }>(
    ["device", "info", "files", "-d", deviceCtlId, "--domain-type", "systemCrashLogs"],
    120_000,
  );
  return (r.files ?? []).map((f) => ({
    name: f.path ?? f.name ?? "",
    sizeBytes: typeof f.size === "number" ? f.size : 0,
    // devicectl reports epoch seconds as a float.
    modifiedAt:
      typeof f.modificationDate === "number"
        ? new Date(f.modificationDate * 1000)
        : null,
  }));
}

/** Copy one crash report off the device. Returns the local path. */
export async function copyCrashFile(
  deviceCtlId: string,
  name: string,
  destDir: string,
): Promise<string> {
  const local = join(destDir, name.split("/").pop()!);
  await json(
    [
      "device", "copy", "from",
      "-d", deviceCtlId,
      "--domain-type", "systemCrashLogs",
      "--source", name,
      "--destination", local,
    ],
    180_000,
  );
  return local;
}

// ---------------------------------------------------------------------------
// usbmux (cable-only capabilities)
// ---------------------------------------------------------------------------

/**
 * Is this device visible to usbmuxd — i.e. attached by cable and trusted?
 *
 * A device paired over the local network is invisible to usbmux even though
 * devicectl talks to it happily (`transportType: "localNetwork"`), so this is
 * the gate for everything that rides usbmux: `iproxy` port forwarding and
 * `idevicesyslog`. It never blocks a capability that has another route.
 */
export async function usbmuxSees(udid: string): Promise<boolean> {
  const proc = Bun.spawn(["idevice_id", "-l"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]).catch(() => ["", 1] as [string, number]); // libimobiledevice not installed
  if (code !== 0) return false;
  return out
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .includes(udid.toLowerCase());
}

export interface SyslogLinesOptions {
  /** Restrict to one process (the app's executable name). */
  process?: string;
  /** Case-insensitive substring filter on the captured lines. */
  filter?: string;
  /** How long to capture for. usbmux streams live; there is no history. */
  seconds: number;
  /** Max lines returned (most recent kept). */
  lines: number;
}

/**
 * Capture device syslog lines with `idevicesyslog`, LIVE for a few seconds.
 *
 * This is a stream, not a query: unlike a simulator (`log show --last 120s`)
 * there is no unprivileged way to read the past — `log collect --device-udid`
 * exits with "Must be root to collect logs from attached device". So the window
 * is forward-looking, and callers say so in their output.
 */
export async function syslogLines(
  udid: string,
  opts: SyslogLinesOptions,
): Promise<string[]> {
  const args = ["idevicesyslog", "-u", udid, "-q"];
  if (opts.process) args.push("-p", opts.process);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const collected = new Response(proc.stdout).text();
  await Bun.sleep(Math.min(Math.max(opts.seconds, 1), 30) * 1000);
  proc.kill();
  let lines = (await collected).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(f));
  }
  return lines.slice(-opts.lines);
}
