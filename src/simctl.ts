/**
 * simctl.ts — the single chokepoint through which every simulator command flows.
 *
 * Design note: we run the real `xcrun simctl` binary as a subprocess rather
 * than talking to CoreSimulator directly. simctl talks to the system, not to
 * the app, so nothing here assumes a debug build or app cooperation — same
 * philosophy as android-mcp's adb.ts.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run `xcrun <args>` and collect stdout/stderr as UTF-8 text. */
export async function xcrun(
  args: string[],
  timeoutMs = 30_000,
): Promise<ExecResult> {
  const proc = Bun.spawn(["xcrun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Low-level runner: `xcrun simctl <args>`. Returns trimmed stdout; throws
 * with stderr on nonzero exit.
 */
export async function run(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr, exitCode } = await xcrun(
    ["simctl", ...args],
    timeoutMs,
  );
  if (exitCode !== 0) {
    throw new Error(
      `simctl ${args.join(" ")} failed (exit ${exitCode}): ${
        stderr.trim() || stdout.trim()
      }`,
    );
  }
  return stdout.trim();
}

/**
 * Generic escape hatch: `xcrun simctl <args>` where the caller has already
 * placed the udid where the subcommand expects it. `udid` is accepted for
 * call-site readability but args is authoritative.
 */
export async function simctl(udid: string, args: string[]): Promise<string> {
  void udid; // documented in the contract; args carries the placement
  return run(args);
}

export interface SimDevice {
  name: string;
  udid: string;
  iosVersion: string;
  state: "Booted" | "Shutdown";
}

/** Parse `simctl list devices --json`, available devices only. */
export async function listDevices(): Promise<SimDevice[]> {
  const out = await run(["list", "devices", "--json"]);
  const parsed = JSON.parse(out) as {
    devices: Record<
      string,
      Array<{
        name: string;
        udid: string;
        state: string;
        isAvailable: boolean;
      }>
    >;
  };
  const devices: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices)) {
    // "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "26.5"
    const m = runtime.match(/iOS-(\d+)-(\d+)/);
    if (!m) continue; // skip watchOS/tvOS/visionOS runtimes
    const iosVersion = `${m[1]}.${m[2]}`;
    for (const d of list) {
      if (!d.isAvailable) continue;
      devices.push({
        name: d.name,
        udid: d.udid,
        iosVersion,
        state: d.state === "Booted" ? "Booted" : "Shutdown",
      });
    }
  }
  return devices;
}

/** Boot the simulator if shut down, then wait for boot to complete. */
export async function ensureBooted(udid: string): Promise<void> {
  const devices = await listDevices();
  const device = devices.find((d) => d.udid === udid);
  if (!device) {
    throw new Error(
      `No available simulator with udid ${udid}. Known: ${devices
        .map((d) => `${d.name} (${d.udid})`)
        .join(", ")}`,
    );
  }
  if (device.state !== "Booted") {
    // "Unable to boot device in current state: Booted" can race — tolerate it.
    try {
      await run(["boot", udid], 60_000);
    } catch (err) {
      if (!String(err).includes("current state: Booted")) throw err;
    }
  }
  // -b blocks until the boot handshake completes (fast no-op when booted).
  await run(["bootstatus", udid, "-b"], 120_000);
}

/** Launch an app by bundle id; returns its pid. */
export async function launchApp(
  udid: string,
  bundleId: string,
): Promise<number> {
  // Output: "com.example.app: 12345"
  const out = await run(["launch", udid, bundleId], 60_000);
  const m = out.match(/:\s*(\d+)\s*$/);
  if (!m) throw new Error(`Could not parse pid from simctl launch: "${out}"`);
  return parseInt(m[1], 10);
}

/** Terminate an app; tolerates the app not running. */
export async function terminateApp(
  udid: string,
  bundleId: string,
): Promise<void> {
  try {
    await run(["terminate", udid, bundleId]);
  } catch (err) {
    // "found nothing to terminate" / "is not currently running" — fine.
    const msg = String(err);
    if (
      msg.includes("found nothing to terminate") ||
      msg.includes("not currently running") ||
      msg.includes("Unable to lookup in current state")
    ) {
      return;
    }
    throw err;
  }
}
