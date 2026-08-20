/**
 * target.ts — WHAT every tool acts on: one simulator or one physical device.
 *
 * A single Target of server state, resolved lazily: an explicit select_device
 * wins, then IOS_MCP_UDID, then the only obvious candidate. Ambiguity is always
 * an error that lists the candidates — never a silent guess, and never a guess
 * ACROSS kinds (driving the wrong phone is worse than a question).
 */

import { listDevices as listSims, ensureBooted } from "./simctl.ts";
import { listDevices as listPhysical, lockState } from "./devicectl.ts";

export type TargetKind = "sim" | "device";

export interface Target {
  kind: TargetKind;
  /** Simulator UDID, or the device's hardware UDID. */
  udid: string;
  name: string;
  iosVersion: string;
  /** "Booted"/"Shutdown" for simulators; "Connected"/"Unavailable" for devices. */
  state: string;
  /**
   * devicectl's own identifier — the one `devicectl -d` wants. Devices only,
   * and NOT interchangeable with `udid`.
   */
  deviceCtlId?: string;
}

let target: Target | null = null;
/** Pre-selection from the environment, resolved on first use. */
const envUdid = process.env.IOS_MCP_UDID || null;

/** Every target this Mac can drive right now, simulators first. */
export async function listTargets(): Promise<Target[]> {
  const sims: Target[] = (await listSims()).map((d) => ({
    kind: "sim" as const,
    udid: d.udid,
    name: d.name,
    iosVersion: d.iosVersion,
    state: d.state,
  }));
  // A missing/older Xcode toolchain shouldn't take simulators down with it.
  const devices: Target[] = (await listPhysical().catch(() => [])).map((d) => ({
    kind: "device" as const,
    udid: d.udid,
    name: d.name,
    iosVersion: d.iosVersion,
    state: d.available ? "Connected" : "Unavailable",
    deviceCtlId: d.deviceCtlId,
  }));
  return [...sims, ...devices];
}

function describe(t: Target): string {
  return `${t.name} ${t.iosVersion} (${t.udid}) [${t.kind}, ${t.state}]`;
}

/**
 * Make a target usable: boot a shut-down simulator, or check a device is
 * actually reachable and driveable. Turns the two most confusing device
 * failures — unreachable, and Developer Mode off — into sentences.
 */
async function prepare(t: Target): Promise<Target> {
  if (t.kind === "sim") {
    await ensureBooted(t.udid);
    return { ...t, state: "Booted" };
  }
  const live = (await listPhysical()).find((d) => d.udid === t.udid);
  if (!live || !live.available) {
    throw new Error(
      `${t.name} is not reachable (tunnel ${live?.tunnelState ?? "unknown"}). ` +
        "Connect it by cable or put it on this Mac's network, unlock it, and keep it awake.",
    );
  }
  if (live.developerMode !== "enabled") {
    throw new Error(
      `${t.name} has Developer Mode ${live.developerMode} — XCUITest, and so WebDriverAgent, cannot run. ` +
        "Enable it in Settings → Privacy & Security → Developer Mode.",
    );
  }
  // Advisory: a locked phone yields blank trees and stalled taps, not errors.
  const lock = await lockState(live.deviceCtlId).catch(() => null);
  if (lock?.passcodeRequired) {
    console.error(
      `ios-mcp: ${t.name} reports a locked screen — unlock it or WDA will see nothing.`,
    );
  }
  return { ...t, state: "Connected", deviceCtlId: live.deviceCtlId };
}

/** Match a UDID, a devicectl id, or a unique name substring across both kinds. */
export async function selectDevice(udidOrName: string): Promise<Target> {
  const all = await listTargets();
  const needle = udidOrName.toLowerCase();

  const exact = all.filter(
    (t) =>
      t.udid.toLowerCase() === needle || t.deviceCtlId?.toLowerCase() === needle,
  );
  const matches = exact.length
    ? exact
    : all.filter((t) => t.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new Error(
      `Nothing matches "${udidOrName}". Available: ${all.map(describe).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `"${udidOrName}" is ambiguous — matches: ${matches.map(describe).join(", ")}. Use the UDID.`,
    );
  }
  target = await prepare(matches[0]);
  return target;
}

/**
 * The current target, auto-selecting when there is exactly one sensible
 * candidate: a single booted simulator, or a single connected device. One of
 * each is ambiguous — the agent must say which.
 */
export async function getTarget(): Promise<Target> {
  if (target) return target;

  const all = await listTargets();
  if (envUdid) {
    const fromEnv = all.find(
      (t) => t.udid.toLowerCase() === envUdid.toLowerCase(),
    );
    if (!fromEnv) {
      throw new Error(
        `IOS_MCP_UDID=${envUdid} matches no simulator or device. Available: ${all
          .map(describe)
          .join(", ")}`,
      );
    }
    target = await prepare(fromEnv);
    return target;
  }

  const ready = all.filter(
    (t) => t.state === "Booted" || t.state === "Connected",
  );
  if (ready.length === 1) {
    target = await prepare(ready[0]);
    return target;
  }
  throw new Error(
    ready.length === 0
      ? `No booted simulator and no connected device. Call select_device. Available: ${all
          .map(describe)
          .join(", ")}`
      : `${ready.length} targets are ready — call select_device to pick one: ${ready
          .map(describe)
          .join(", ")}`,
  );
}

/** The current target without resolving one (for list_devices display). */
export function peekTarget(): Target | null {
  return target;
}

/**
 * devicectl's identifier for the current device target, or a clear error.
 * Every device-only backend call needs this, and it is NOT the UDID.
 */
export function requireDeviceCtlId(t: Target): string {
  if (t.kind !== "device" || !t.deviceCtlId) {
    throw new Error(`${t.name} is not a physical device target`);
  }
  return t.deviceCtlId;
}
