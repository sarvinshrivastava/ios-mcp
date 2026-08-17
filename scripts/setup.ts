/**
 * setup.ts — one-time WebDriverAgent fetch + build-for-testing + cache.
 *
 * What it does:
 *   1. Installs the `appium-webdriveragent` npm package (which ships the full
 *      WDA Xcode project) into ~/.cache/ios-mcp/wda-src/ — self-contained,
 *      never touches this repo's package.json.
 *   2. `xcodebuild build-for-testing` against the generic iOS Simulator
 *      destination. No code signing — simulator builds need none. Fully
 *      local; nothing here talks to Apple's cloud.
 *   3. Caches the products + .xctestrun under
 *      ~/.cache/ios-mcp/wda/<xcode-build-version>/ with a manifest.json.
 *
 * Idempotent: a valid existing cache for the current Xcode build is a no-op.
 * `bun run setup --force` rebuilds from scratch.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { xcrun } from "../src/simctl.ts";

const FORCE = process.argv.includes("--force");

const CACHE_ROOT =
  process.env.IOS_MCP_WDA_HOME || join(homedir(), ".cache", "ios-mcp", "wda");
const SRC_DIR = join(homedir(), ".cache", "ios-mcp", "wda-src");

export interface WdaManifest {
  xcodeVersion: string; // "Xcode 26.6"
  xcodeBuild: string; // "17F113"
  xctestrun: string; // absolute path
  builtAt: string; // ISO timestamp
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

async function main() {
  const { version, build } = await xcodeVersion();
  const cacheDir = join(CACHE_ROOT, build);
  const manifestPath = join(cacheDir, "manifest.json");
  const derivedDir = join(cacheDir, "derived");

  // ---- idempotency check -------------------------------------------------
  if (!FORCE) {
    const existing = await Bun.file(manifestPath)
      .json()
      .catch(() => null);
    if (
      existing &&
      existing.xcodeBuild === build &&
      (await Bun.file(existing.xctestrun).exists())
    ) {
      console.log(
        `WDA cache valid for ${version} (${build}) — nothing to do.\n` +
          `  xctestrun: ${existing.xctestrun}\n` +
          `  built:     ${existing.builtAt}\n` +
          `Re-run with --force to rebuild.`,
      );
      return;
    }
  }

  console.log(`Building WDA for ${version} (${build})...`);

  // ---- 1. fetch WDA source ----------------------------------------------
  const wdaProject = join(
    SRC_DIR,
    "node_modules",
    "appium-webdriveragent",
    "WebDriverAgent.xcodeproj",
  );
  const haveSource = await Bun.file(
    join(wdaProject, "project.pbxproj"),
  ).exists();
  if (FORCE || !haveSource) {
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
  } else {
    console.log(`WDA source already present at ${SRC_DIR}`);
  }

  // ---- 2. build-for-testing (local only, no signing, no cloud) -----------
  if (FORCE) await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  console.log("Running xcodebuild build-for-testing (~3-5 min)...");
  await sh(
    [
      "xcodebuild",
      "build-for-testing",
      "-project",
      wdaProject,
      "-scheme",
      "WebDriverAgentRunner",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derivedDir,
      "CODE_SIGNING_ALLOWED=NO",
    ],
    { timeoutMs: 600_000, label: "xcodebuild build-for-testing" },
  );

  // ---- 3. manifest ---------------------------------------------------------
  const xctestrun = await findXctestrun(join(derivedDir, "Build", "Products"));
  const manifest: WdaManifest = {
    xcodeVersion: version,
    xcodeBuild: build,
    xctestrun,
    builtAt: new Date().toISOString(),
  };
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  // Keep the simulator's software keyboard alive — a connected hardware
  // keyboard swallows the on-screen one and breaks type_into.
  await sh(
    [
      "defaults",
      "write",
      "com.apple.iphonesimulator",
      "ConnectHardwareKeyboard",
      "-bool",
      "false",
    ],
    { label: "defaults write ConnectHardwareKeyboard" },
  ).catch((err) => console.warn(`(non-fatal) ${err}`));

  console.log(
    `WDA build cached.\n  xctestrun: ${xctestrun}\n  manifest:  ${manifestPath}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
