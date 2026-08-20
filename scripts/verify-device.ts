/**
 * verify-device.ts — P0 risk burn-down for real-device support.
 *
 * Proves the whole chain that v1 never exercised, in the order it can fail:
 * device reachable → unlocked → signed WDA cached and provisioning this device
 * → runner launches over the cable → tunnel open → /status green → a real tree
 * and screen info come back.
 *
 * Usage: bun run scripts/verify-device.ts [udid]
 */

import { listDevices, lockState } from "../src/devicectl.ts";
import { ensureWda, shutdownWda } from "../src/wda.ts";

function ms(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

async function main() {
  const wanted = process.argv[2];

  const devices = await listDevices();
  if (devices.length === 0) throw new Error("devicectl sees no iOS devices at all.");
  console.log("Devices known to CoreDevice:");
  for (const d of devices) {
    console.log(
      `  ${d.available ? "*" : " "} ${d.name} — iOS ${d.iosVersion} — udid ${d.udid} — ` +
        `transport ${d.transport ?? "none"} — tunnel ${d.tunnelState} — devMode ${d.developerMode}`,
    );
  }

  const device = wanted
    ? devices.find((d) => d.udid === wanted || d.deviceCtlId === wanted)
    : devices.filter((d) => d.available)[0];
  if (!device) throw new Error(wanted ? `No device matches ${wanted}` : "No reachable device.");
  if (!device.available) {
    throw new Error(`${device.name} is unreachable (tunnelState ${device.tunnelState}).`);
  }
  if (device.developerMode !== "enabled") {
    throw new Error(
      `${device.name} has Developer Mode ${device.developerMode} — XCUITest (and so WDA) cannot run. ` +
        "Enable it in Settings → Privacy & Security → Developer Mode.",
    );
  }
  console.log(`\nTarget: ${device.name} (${device.udid})`);

  const lock = await lockState(device.deviceCtlId);
  console.log(
    `Lock: passcodeRequired=${lock.passcodeRequired} unlockedSinceBoot=${lock.unlockedSinceBoot}`,
  );
  if (lock.passcodeRequired) {
    console.warn("  ! Unlock the screen and keep it awake — WDA cannot drive a locked device.");
  }

  const t0 = Date.now();
  console.log("\nStarting WDA on the device (first run also installs the runner app)...");
  const wda = await ensureWda({ kind: "device", udid: device.udid });
  const route = wda.baseUrl.includes("localhost")
    ? "USB tunnel (iproxy)"
    : "the device's own address over the network";
  console.log(`WDA ready in ${ms(t0)} at ${wda.baseUrl} — via ${route}`);

  const status = await wda.status(10_000);
  console.log(
    `/status: ready=${status?.ready} os=${status?.os?.name} ${status?.os?.version} ` +
      `wda=${status?.build?.version ?? "?"}`,
  );

  const app = await wda.activeAppInfo();
  console.log(`/wda/activeAppInfo: bundleId=${app?.bundleId} pid=${app?.pid}`);

  const t1 = Date.now();
  const source = await wda.source();
  const treeSize = JSON.stringify(source).length;
  console.log(`/source: ${treeSize} bytes in ${ms(t1)}`);

  const screen = await wda.screenInfo();
  console.log(`/wda/screen: scale=${screen.scale} statusBar=${JSON.stringify(screen.statusBarSize)}`);

  console.log(`\nP0 PASS — signed WDA runs on a real device and answers over ${route}.`);
}

main()
  .catch((err) => {
    console.error(`\nP0 FAIL — ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => shutdownWda());
