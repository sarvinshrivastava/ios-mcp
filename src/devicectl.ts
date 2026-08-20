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
