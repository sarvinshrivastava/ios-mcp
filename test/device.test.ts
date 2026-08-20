/**
 * Unit coverage for the real-device plumbing that does NOT need hardware:
 * devicectl's undocumented JSON shape, and which provisioning profile may sign
 * WebDriverAgent. Both are places where a silent Apple-side rename or a wrong
 * wildcard rule would fail confusingly at runtime.
 *
 * The devicectl fixture is a real `devicectl list devices --json-output` dump
 * (Xcode 26.6): one reachable iPhone on iOS 27 and one unreachable iPhone.
 */

import { expect, test, describe } from "bun:test";
import { parseDevices } from "../src/devicectl.ts";
import { coversBundleId, WDA_RUNNER_BUNDLE_ID, type Profile } from "../src/signing.ts";
import fixture from "./fixtures/devicectl-devices.json";

describe("parseDevices", () => {
  const devices = parseDevices((fixture as any).result);

  test("reads both iPhones with UDID, devicectl id and OS", () => {
    expect(devices).toHaveLength(2);
    const himanshu = devices.find((d) => d.name.includes("Himanshu"))!;
    expect(himanshu.udid).toBe("00008101-0011685C1422001E");
    expect(himanshu.deviceCtlId).toBe("1F2B10B6-A456-59F7-8F86-DD08FD719910");
    expect(himanshu.iosVersion).toBe("27.0");
    expect(himanshu.deviceType).toBe("iPhone");
  });

  test("the UDID and the devicectl identifier are NOT interchangeable", () => {
    // iproxy / log / profiles want the UDID; `devicectl -d` wants the id.
    for (const d of devices) expect(d.udid).not.toBe(d.deviceCtlId);
  });

  test("availability follows CoreDevice's tunnelState, not pairing", () => {
    const reachable = devices.find((d) => d.tunnelState !== "unavailable")!;
    const gone = devices.find((d) => d.tunnelState === "unavailable")!;
    expect(reachable.available).toBe(true);
    expect(gone.available).toBe(false);
    // Both are paired — pairing alone must never imply usable.
    expect(gone.pairingState).toBe("paired");
  });

  test("carries the preconditions WDA needs, without judging them", () => {
    const d = devices.find((d) => d.available)!;
    expect(d.developerMode).toBe("enabled");
    expect(typeof d.ddiServicesAvailable).toBe("boolean");
    expect(d.transport === null || typeof d.transport === "string").toBe(true);
  });

  test("tolerates an empty or field-less payload instead of throwing", () => {
    expect(parseDevices({})).toEqual([]);
    // A device with no hardwareProperties has no UDID and is dropped.
    expect(parseDevices({ devices: [{ identifier: "x" }] })).toEqual([]);
  });

  test("skips non-iOS platforms (paired Macs and Watches also appear)", () => {
    const withMac = {
      devices: [
        ...(fixture as any).result.devices,
        {
          identifier: "MAC",
          hardwareProperties: { platform: "macOS", udid: "MACUDID", deviceType: "mac" },
          deviceProperties: { name: "A Mac" },
        },
      ],
    };
    expect(parseDevices(withMac).map((d) => d.name)).not.toContain("A Mac");
  });
});

describe("coversBundleId", () => {
  const profile = (appIdentifier: string): Profile => ({
    path: "/dev/null",
    name: "test",
    uuid: "u",
    teamId: "TEAM123456",
    appIdentifier,
    development: true,
    expiresAt: new Date("2030-01-01"),
    devices: [],
  });

  test("a wildcard team profile covers WDA's runner bundle", () => {
    expect(coversBundleId(profile("TEAM123456.*"), WDA_RUNNER_BUNDLE_ID)).toBe(true);
  });

  test("a prefix wildcard covers only that prefix", () => {
    const p = profile("TEAM123456.com.facebook.*");
    expect(coversBundleId(p, "com.facebook.WebDriverAgentRunner.xctrunner")).toBe(true);
    expect(coversBundleId(p, "com.habuild.yatraready")).toBe(false);
  });

  test("an explicit app id matches exactly and nothing broader", () => {
    const p = profile("TEAM123456.com.habuild.yatraready");
    expect(coversBundleId(p, "com.habuild.yatraready")).toBe(true);
    expect(coversBundleId(p, "com.habuild.yatraready.extension")).toBe(false);
    expect(coversBundleId(p, WDA_RUNNER_BUNDLE_ID)).toBe(false);
  });
});
