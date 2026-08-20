/**
 * setup.ts — one-time WebDriverAgent fetch + build-for-testing + cache.
 *
 * Two build flavors, cached side by side under the Xcode build version:
 *
 *   ~/.cache/ios-mcp/wda/<xcode-build>/sim/     — simulators, CODE_SIGNING_ALLOWED=NO
 *   ~/.cache/ios-mcp/wda/<xcode-build>/device/  — real devices, manually signed
 *
 *   bun run setup            → simulator build (default, v1 behavior)
 *   bun run setup --device   → real-device build
 *   bun run setup --all      → both
 *   … --force                → rebuild the selected flavor(s) from scratch
 *
 * Both builds are LOCAL. The device build signs with a certificate and a
 * provisioning profile that are already installed on this Mac and never passes
 * `-allowProvisioningUpdates`, which would register devices / mint profiles in
 * Apple's Developer portal. If no local profile fits, setup fails and says
 * which piece is missing (see signing.ts).
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { xcrun } from "../src/simctl.ts";
import { selectSigningAssets, type SigningAssets } from "../src/signing.ts";

const FORCE = process.argv.includes("--force");
const WANT_DEVICE = process.argv.includes("--device") || process.argv.includes("--all");
const WANT_SIM = process.argv.includes("--all") || !process.argv.includes("--device");
/** `--udid <udid>`: require the profile to provision this specific device. */
const UDID_ARG = (() => {
  const i = process.argv.indexOf("--udid");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

const CACHE_ROOT =
  process.env.IOS_MCP_WDA_HOME || join(homedir(), ".cache", "ios-mcp", "wda");
const SRC_DIR = join(homedir(), ".cache", "ios-mcp", "wda-src");

export type WdaKind = "sim" | "device";

export interface WdaManifest {
  kind: WdaKind;
  xcodeVersion: string; // "Xcode 26.6"
  xcodeBuild: string; // "17F113"
  xctestrun: string; // absolute path
  builtAt: string; // ISO timestamp
  /** Signing provenance — device builds only. */
  teamId?: string;
  profileUuid?: string;
  profileName?: string;
  identityName?: string;
  /** UDIDs the signing profile provisions; a target outside this list can't run. */
  provisionedDevices?: string[];
}

async function sh(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; label?: string } = {},
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${opts.label || cmd[0]} failed (exit ${exitCode}):\n${stderr.slice(-4000) || stdout.slice(-4000)}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/** "Xcode 26.6\nBuild version 17F113" → { version, build } */
export async function xcodeVersion(): Promise<{
  version: string;
  build: string;
}> {
  const { stdout, stderr, exitCode } = await xcrun(["xcodebuild", "-version"]);
  if (exitCode !== 0) throw new Error(`xcodebuild -version failed: ${stderr}`);
  const version = stdout.match(/^Xcode .+$/m)?.[0];
  const build = stdout.match(/^Build version (\S+)$/m)?.[1];
  if (!version || !build) {
    throw new Error(`Could not parse xcodebuild -version output:\n${stdout}`);
  }
  return { version, build };
}

async function findXctestrun(productsDir: string): Promise<string> {
  const entries = await readdir(productsDir).catch(() => [] as string[]);
  const runs = entries.filter((f) => f.endsWith(".xctestrun"));
  if (runs.length === 0) {
    throw new Error(`No .xctestrun found in ${productsDir}`);
  }
  // Prefer the WebDriverAgentRunner one if several schemes ever land here.
  const preferred =
    runs.find((f) => f.includes("WebDriverAgentRunner")) || runs[0];
  return join(productsDir, preferred);
}

/** Fetch the WDA Xcode project (shipped inside the appium-webdriveragent npm package). */
async function ensureSource(): Promise<string> {
  const wdaProject = join(
    SRC_DIR,
    "node_modules",
    "appium-webdriveragent",
    "WebDriverAgent.xcodeproj",
  );
  if (await Bun.file(join(wdaProject, "project.pbxproj")).exists()) {
    console.log(`WDA source already present at ${SRC_DIR}`);
    return wdaProject;
  }
  console.log(`Fetching appium-webdriveragent into ${SRC_DIR} ...`);
  await rm(SRC_DIR, { recursive: true, force: true });
  await mkdir(SRC_DIR, { recursive: true });
  await Bun.write(
    join(SRC_DIR, "package.json"),
    JSON.stringify(
      {
        name: "ios-mcp-wda-src",
        private: true,
        dependencies: { "appium-webdriveragent": "latest" },
      },
      null,
      2,
    ),
  );
  await sh(["bun", "install", "--cwd", SRC_DIR], {
    timeoutMs: 300_000,
    label: "bun install (appium-webdriveragent)",
  });
  if (!(await Bun.file(join(wdaProject, "project.pbxproj")).exists())) {
    throw new Error(`WDA project not found after install: ${wdaProject}`);
  }
  return wdaProject;
}

/**
 * build-for-testing for one flavor and write its manifest.
 *
 * Simulator: no signing at all. Device: automatic signing pinned to one team,
 * with the profile that signing.ts already proved exists locally and covers the
 * target device — see the argument list for why automatic beats manual here.
 */
async function buildFlavor(
  kind: WdaKind,
  wdaProject: string,
  version: string,
  build: string,
  signing?: SigningAssets,
): Promise<WdaManifest> {
  const cacheDir = join(CACHE_ROOT, build, kind);
  const derivedDir = join(cacheDir, "derived");
  const manifestPath = join(cacheDir, "manifest.json");

  if (!FORCE) {
    const existing = (await Bun.file(manifestPath).json().catch(() => null)) as WdaManifest | null;
    if (
      existing &&
      existing.xcodeBuild === build &&
      (await Bun.file(existing.xctestrun).exists())
    ) {
      console.log(
        `WDA ${kind} cache valid for ${version} (${build}) — nothing to do.\n` +
          `  xctestrun: ${existing.xctestrun}\n` +
          `  built:     ${existing.builtAt}\n` +
          `Re-run with --force to rebuild.`,
      );
      return existing;
    }
  } else {
    await rm(cacheDir, { recursive: true, force: true });
  }

  await mkdir(cacheDir, { recursive: true });
  console.log(`Running xcodebuild build-for-testing (${kind}, ~3-5 min)...`);

  const common = [
    "xcodebuild",
    "build-for-testing",
    "-project",
    wdaProject,
    "-scheme",
    "WebDriverAgentRunner",
    "-derivedDataPath",
    derivedDir,
  ];
  const args =
    kind === "sim"
      ? [...common, "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=NO"]
      : [
          ...common,
          "-destination",
          "generic/platform=iOS",
          // Automatic style, team only — deliberately NOT manual with an
          // explicit profile. Verified on Xcode 26.6: manual signing rejects
          // the only profiles that exist here ("… is Xcode managed, but signing
          // settings require a manually managed profile"), and naming a profile
          // also breaks the framework target ("WebDriverAgentLib does not
          // support provisioning profiles"). Automatic picks the same local
          // profile that signing.ts validated.
          //
          // `-allowProvisioningUpdates` is NEVER passed: it registers devices
          // and mints profiles in Apple's Developer portal. Without it Xcode
          // may only use assets already on this Mac, which is the whole point.
          "CODE_SIGN_STYLE=Automatic",
          `DEVELOPMENT_TEAM=${signing!.identity.teamId}`,
        ];

  await sh(args, { timeoutMs: 900_000, label: `xcodebuild build-for-testing (${kind})` });

  const xctestrun = await findXctestrun(join(derivedDir, "Build", "Products"));
  const manifest: WdaManifest = {
    kind,
    xcodeVersion: version,
    xcodeBuild: build,
    xctestrun,
    builtAt: new Date().toISOString(),
    ...(signing
      ? {
          teamId: signing.identity.teamId,
          profileUuid: signing.profile.uuid,
          profileName: signing.profile.name,
          identityName: signing.identity.name,
          provisionedDevices: signing.profile.devices,
        }
      : {}),
  };
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`WDA ${kind} build cached.\n  xctestrun: ${xctestrun}\n  manifest:  ${manifestPath}`);
  return manifest;
}

async function main() {
  const { version, build } = await xcodeVersion();
  const wdaProject = await ensureSource();

  if (WANT_SIM) {
    await buildFlavor("sim", wdaProject, version, build);
    // Keep the simulator's software keyboard alive — a connected hardware
    // keyboard swallows the on-screen one and breaks type_into.
    await sh(
      ["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"],
      { label: "defaults write ConnectHardwareKeyboard" },
    ).catch((err) => console.warn(`(non-fatal) ${err}`));
  }

  if (WANT_DEVICE) {
    const signing = await selectSigningAssets({ udid: UDID_ARG });
    console.log(
      `Signing WDA for device with:\n` +
        `  identity: ${signing.identity.name} (team ${signing.identity.teamId})\n` +
        `  profile:  ${signing.profile.name} [${signing.profile.uuid}] — ${signing.profile.devices.length} device(s)`,
    );
    await buildFlavor("device", wdaProject, version, build, signing);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
