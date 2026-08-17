/**
 * target.ts — which simulator every tool acts on.
 *
 * One UDID of server state, resolved lazily: an explicit select_device wins,
 * then IOS_MCP_UDID, then the single booted simulator. Ambiguity is an error
 * that lists the candidates — never a silent guess.
 */

import { listDevices, ensureBooted, type SimDevice } from "./simctl.ts";

let targetUdid: string | null = process.env.IOS_MCP_UDID || null;

/** Set the target simulator (boots it if shut down). Accepts a UDID or a
 * unique name substring. Returns the resolved device. */
export async function selectDevice(udidOrName: string): Promise<SimDevice> {
  const devices = await listDevices();
  const needle = udidOrName.toLowerCase();
  const matches = devices.filter((d) => d.udid.toLowerCase() === needle) || [];
  const byName = matches.length
    ? matches
    : devices.filter((d) => d.name.toLowerCase().includes(needle));
  if (byName.length === 0) {
    throw new Error(
      `No simulator matches "${udidOrName}". Available: ${devices
        .map((d) => `${d.name} ${d.iosVersion} (${d.udid}) [${d.state}]`)
        .join(", ")}`,
    );
  }
  if (byName.length > 1) {
    throw new Error(
      `"${udidOrName}" is ambiguous — matches: ${byName
        .map((d) => `${d.name} ${d.iosVersion} (${d.udid})`)
        .join(", ")}. Use the UDID.`,
    );
  }
  const device = byName[0];
  await ensureBooted(device.udid);
  targetUdid = device.udid;
  return device;
}

/** The current target UDID, auto-selecting the single booted sim if unset. */
export async function getTargetUdid(): Promise<string> {
  if (targetUdid) return targetUdid;
  const booted = (await listDevices()).filter((d) => d.state === "Booted");
  if (booted.length === 1) {
    targetUdid = booted[0].udid;
    return targetUdid;
  }
  const devices = await listDevices();
  throw new Error(
    booted.length === 0
      ? `No booted simulator. Call select_device first. Available: ${devices
          .map((d) => `${d.name} ${d.iosVersion} (${d.udid})`)
          .join(", ")}`
      : `${booted.length} simulators are booted — call select_device. Booted: ${booted
          .map((d) => `${d.name} ${d.iosVersion} (${d.udid})`)
          .join(", ")}`,
  );
}

/** The target UDID without auto-selection (for list_devices display). */
export function peekTargetUdid(): string | null {
  return targetUdid;
}
