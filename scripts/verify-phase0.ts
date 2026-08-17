/**
 * verify-phase0.ts — Phase 0 exit criterion, executed.
 *
 * Picks a simulator (IOS_MCP_UDID, else a booted one, else the iPhone 17),
 * boots it, ensures WDA is up, prints /status, creates a session, counts
 * /source elements, and prints the screen scale. Kills the spawned WDA child
 * on exit (the process `exit` hook in wda.ts handles that).
 */

import { listDevices } from "../src/simctl.ts";
import { ensureWda, killOrphanWda } from "../src/wda.ts";

function countNodes(node: any): number {
  if (!node || typeof node !== "object") return 0;
  const children: any[] = Array.isArray(node.children) ? node.children : [];
  return 1 + children.reduce((n, c) => n + countNodes(c), 0);
}

async function pickUdid(): Promise<string> {
  const devices = await listDevices();
  if (devices.length === 0) throw new Error("No available simulators");
  const fromEnv = process.env.IOS_MCP_UDID;
  if (fromEnv) return fromEnv;
  const booted = devices.find((d) => d.state === "Booted");
  if (booted) return booted.udid;
  const preferred =
    devices.find((d) => d.name === "iPhone 17") ||
    devices.find((d) => d.name.startsWith("iPhone")) ||
    devices[0];
  return preferred.udid;
}

async function main() {
  const orphansKilled = await killOrphanWda();
  if (orphansKilled)
    console.log(`Killed ${orphansKilled} orphan WDA runner(s)`);

  const udid = await pickUdid();
  const device = (await listDevices()).find((d) => d.udid === udid);
  console.log(
    `Target: ${device?.name ?? "?"} (${udid}) iOS ${device?.iosVersion ?? "?"} [${device?.state ?? "?"}]`,
  );

  const t0 = Date.now();
  const client = await ensureWda(udid);
  console.log(`ensureWda ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const status = await client.status();
  console.log(`/status: ${JSON.stringify(status, null, 2)}`);

  const sessionId = await client.ensureSession();
  console.log(`session: ${sessionId}`);

  const source = await client.source();
  const root = typeof source === "string" ? JSON.parse(source) : source;
  console.log(`/source element count: ${countNodes(root)}`);

  const screen = await client.screenInfo();
  console.log(`screen scale: ${screen.scale}`);

  const appInfo = await client.activeAppInfo();
  console.log(`active app: ${JSON.stringify(appInfo)}`);

  console.log("PHASE 0 VERIFY: PASS");
}

main().catch((err) => {
  console.error(
    String(err instanceof Error ? (err.stack ?? err.message) : err),
  );
  process.exit(1);
});
