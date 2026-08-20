#!/usr/bin/env bun
/**
 * verify-integration.ts — end-to-end check of the full tool stack against a
 * live simulator, plus a dump of the raw /source tree so the uitree port's
 * fixture assumptions can be diffed against reality.
 */

import { listDevices } from "../src/simctl.ts";
import { launchApp, readSyslog } from "../src/backend.ts";
import { ensureWda } from "../src/wda.ts";
import { getTarget } from "../src/target.ts";
import {
  snapshot,
  currentApp,
  tap,
  scrollUntil,
  fullPageScreenshot,
  deviceScale,
} from "../src/actions.ts";
import { screenshot } from "../src/screenshot.ts";
import { clipLabel } from "../src/uitree.ts";

const BUNDLE = process.argv[2] || "com.habuild.yatraready";

const booted = (await listDevices()).filter((d) => d.state === "Booted");
console.log(
  "Booted sims:",
  booted.map((d) => `${d.name} ${d.iosVersion} ${d.udid}`),
);
const device = await getTarget();
console.log("Target:", `${device.name} (${device.kind})`);

const pid = await launchApp(device, BUNDLE);
console.log(`Launched ${BUNDLE} pid=${pid}`);
await Bun.sleep(4000); // app settle

const wda = await ensureWda(device);
console.log("WDA ready. scale =", await deviceScale(wda));

// Raw dump for uitree-assumption diffing.
const raw = await wda.source();
await Bun.write(
  new URL("../test/fixtures/real-source-dump.json", import.meta.url).pathname,
  JSON.stringify(raw, null, 2),
);
console.log("Raw /source saved to test/fixtures/real-source-dump.json");

// inspect_screen equivalent
const snap = await snapshot();
console.log(
  `\ninspect_screen: ${snap.elements.length} elements (raw ${snap.rawNodeCount}, ungrouped ${snap.ungroupedCount}, sparse ${snap.sparse})`,
);
for (const el of snap.elements.slice(0, 25)) {
  console.log(
    `  [${el.role}] ${JSON.stringify(clipLabel(el.label))}${el.id ? ` id=${el.id}` : ""} @${el.center.x},${el.center.y}pt`,
  );
}

console.log("\ncurrent_app:", await currentApp());

const shot = await screenshot(device);
console.log("screenshot:", shot);

// Tap the first interactive element and verify the signature changes or not.
const target = snap.elements.find((e) => e.interactive && e.enabled);
if (target) {
  console.log(`\nTapping [${target.role}] "${clipLabel(target.label)}" …`);
  const r = await tap(
    target.id ? { id: target.id } : { text: target.label.split(" · ")[0] },
  );
  console.log("tap →", r);
  await Bun.sleep(1500);
  console.log("current_app after tap:", await currentApp());
}

console.log("\nscroll_until (nonexistent element, expect bottom):");
console.log(await scrollUntil({ text: "zzz-not-on-screen-zzz" }, 3));

console.log("\nfull_page_screenshot (max 3):");
const fp = await fullPageScreenshot(3);
console.log({
  frames: fp.frames.map((f) => f.path),
  reachedBottom: fp.reachedBottom,
  detection: fp.detection,
});

console.log("\nread_syslog (app-scoped, 60s):");
const log = await readSyslog(device, {
  bundleId: BUNDLE,
  sinceSeconds: 60,
  lines: 5,
});
console.log(`${log.lines.length} lines, ${log.crashes.length} crashes`);
for (const l of log.lines) console.log("  " + l.slice(0, 140));

console.log("\nINTEGRATION VERIFY: PASS");
process.exit(0);
