/**
 * wda.ts — WebDriverAgent lifecycle + HTTP client, for simulators AND devices.
 *
 * One WDA instance per target UDID, each reachable on its own LOCAL port (base
 * IOS_MCP_WDA_PORT_BASE, default 8100). The runner is launched with
 * `xcodebuild test-without-building` against the .xctestrun cached by
 * `bun run setup [--device]`, health-checked over plain HTTP, and reused across
 * calls. All driving happens over fetch — no Appium server, no client library.
 *
 * The two backends differ in exactly two places:
 *
 *   - which cached build is used (simulator builds are unsigned; device builds
 *     are signed with local assets — see signing.ts);
 *   - reachability. On a simulator WDA's listening port IS a localhost port. On
 *     a device it listens on port 8100 ON THE PHONE, so an `iproxy` child
 *     forwards a free local port to it over usbmux. Everything above this file
 *     just sees http://localhost:<localPort>.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { ensureBooted, listDevices, xcrun } from "./simctl.ts";
import { listDevices as listPhysicalDevices } from "./devicectl.ts";

const PORT_BASE = parseInt(process.env.IOS_MCP_WDA_PORT_BASE || "8100", 10);
const CACHE_ROOT =
  process.env.IOS_MCP_WDA_HOME || join(homedir(), ".cache", "ios-mcp", "wda");

/** WDA's own listening port on a physical device (fixed; we tunnel to it). */
const DEVICE_WDA_PORT = 8100;

export type TargetKind = "sim" | "device";

/** The minimum a WDA caller must know about what it is driving. */
export interface WdaTarget {
  kind: TargetKind;
  udid: string;
}

function setupHint(kind: TargetKind): string {
  return kind === "device"
    ? "re-run `bun run setup --device`"
    : "re-run `bun run setup`";
}

interface WdaManifest {
  kind?: TargetKind;
  xcodeVersion: string;
  xcodeBuild: string;
  xctestrun: string;
  builtAt: string;
  profileName?: string;
  provisionedDevices?: string[];
}

interface WdaInstance {
  udid: string;
  kind: TargetKind;
  /** Port on THIS machine that reaches WDA (tunnel entrance for devices). */
  port: number;
  client: WdaClient;
  /** Child handle when this server spawned the runner; null when reusing. */
  child: ReturnType<typeof Bun.spawn> | null;
  /** iproxy child forwarding port → device:8100. Devices only. */
  tunnel: ReturnType<typeof Bun.spawn> | null;
  /**
   * Has this instance's endpoint been established for THIS target?
   *
   * A device's address is only known after its runner announces it, so until
   * then the client still holds the default localhost URL — which another
   * target's WDA (a simulator on the same port) would happily answer. Health
   * checks are meaningless, and actively dangerous, before this is true.
   */
  resolved: boolean;
}

/** Port + process registry, keyed by UDID. */
const registry = new Map<string, WdaInstance>();

function portFor(udid: string): number {
  const existing = registry.get(udid);
  if (existing) return existing.port;
  const used = new Set([...registry.values()].map((i) => i.port));
  let port = PORT_BASE;
  while (used.has(port)) port++;
  return port;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** WDA speaks the W3C WebDriver wire format: everything is `{ value }`. */
function unwrap<T = any>(body: any, context: string): T {
  if (body && typeof body === "object" && "value" in body) {
    const v = body.value;
    if (v && typeof v === "object" && "error" in v && v.error) {
      const err = new Error(`WDA ${context}: ${v.error} — ${v.message ?? ""}`);
      (err as any).wdaError = v.error;
      throw err;
    }
    return v as T;
  }
  return body as T;
}

function isInvalidSession(err: unknown): boolean {
  return (
    (err as any)?.wdaError === "invalid session id" ||
    String(err).includes("invalid session id")
  );
}

export class WdaClient {
  /**
   * Where WDA actually answers. A simulator is always localhost; a device is
   * either a localhost tunnel entrance or the phone's own LAN address, decided
   * at launch — so this is set, not assumed.
   */
  baseUrl: string;
  private sessionId: string | null = null;

  constructor(
    readonly udid: string,
    readonly port: number,
  ) {
    this.baseUrl = `http://localhost:${port}`;
  }

  /** Raw GET on a server-rooted path (no session prefix). */
  async get<T = any>(path: string, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return unwrap<T>(await res.json(), `GET ${path}`);
  }

  /** Raw POST on a server-rooted path (no session prefix). */
  async post<T = any>(
    path: string,
    body: unknown = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return unwrap<T>(await res.json(), `POST ${path}`);
  }

  /** GET /status — WDA health. Throws on connection refused. */
  async status(timeoutMs = 2_000): Promise<any> {
    return this.get("/status", timeoutMs);
  }

  /**
   * Create (or reuse) a WDA session. Empty capabilities = attach to whatever
   * app is foreground. Applies tree-dump settings after create.
   */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as any;
    const value = unwrap<any>(body, "POST /session");
    const sessionId: string | undefined = value?.sessionId ?? body?.sessionId;
    if (!sessionId) {
      throw new Error(
        `WDA POST /session returned no sessionId: ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
    this.sessionId = sessionId;
    // Deep RN/SwiftUI trees can make /source crawl — cap the snapshot.
    await this.post(`/session/${sessionId}/appium/settings`, {
      settings: { snapshotMaxDepth: 50, customSnapshotTimeout: 15 },
    }).catch(() => {}); // settings failure is not fatal to the session
    return sessionId;
  }

  /** Drop the cached session id (e.g. after WDA restart). */
  invalidateSession(): void {
    this.sessionId = null;
  }

  /**
   * Run a session-scoped request; on `invalid session id`, recreate the
   * session once and retry.
   */
  private async withSession<T>(
    fn: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    const sessionId = await this.ensureSession();
    try {
      return await fn(sessionId);
    } catch (err) {
      if (!isInvalidSession(err)) throw err;
      this.sessionId = null;
      return fn(await this.ensureSession());
    }
  }

  /** Full accessibility tree: GET /source?format=json. */
  async source(): Promise<any> {
    // Sessionless route; dumps the foreground app's tree. 60s: big RN trees.
    return this.get("/source?format=json", 60_000);
  }

  /** W3C actions: POST /session/:id/actions. Coordinates are in POINTS. */
  async performActions(actions: unknown[]): Promise<void> {
    await this.withSession((sid) =>
      this.post(`/session/${sid}/actions`, { actions }),
    );
  }

  /** Type into the focused element: POST /session/:id/wda/keys. */
  async keys(text: string): Promise<void> {
    await this.withSession((sid) =>
      this.post(`/session/${sid}/wda/keys`, { value: [...text] }),
    );
  }

  /** Foreground app info: { bundleId, pid, name, processArguments }. */
  async activeAppInfo(): Promise<any> {
    // Sessionless route — works even before a session exists.
    return this.get("/wda/activeAppInfo");
  }

  /** Screen info: { scale, statusBarSize } — scale converts points→pixels. */
  async screenInfo(): Promise<{
    scale: number;
    statusBarSize: { width: number; height: number };
  }> {
    return this.withSession((sid) => this.get(`/session/${sid}/wda/screen`));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Load the cached build for one flavor, refusing to guess.
 *
 * Layout is `<cache>/<xcode-build>/<kind>/manifest.json`. v1 wrote the
 * simulator manifest one level up, so that path is still accepted for `sim` —
 * an existing install must not be forced into a 5-minute rebuild by an upgrade.
 */
async function loadManifest(
  kind: TargetKind,
  udid?: string,
): Promise<WdaManifest> {
  const { stdout, exitCode } = await xcrun(["xcodebuild", "-version"]);
  const build = exitCode === 0 && stdout.match(/^Build version (\S+)$/m)?.[1];
  if (!build)
    throw new Error(
      "Could not read Xcode version (xcodebuild -version failed)",
    );

  const candidates = [join(CACHE_ROOT, build, kind, "manifest.json")];
  if (kind === "sim") candidates.push(join(CACHE_ROOT, build, "manifest.json"));

  let manifest: WdaManifest | null = null;
  for (const path of candidates) {
    manifest = (await Bun.file(path).json().catch(() => null)) as WdaManifest | null;
    if (manifest) break;
  }
  if (!manifest) {
    throw new Error(
      `No ${kind} WDA build cached for Xcode build ${build} — ${setupHint(kind)}`,
    );
  }
  if (manifest.xcodeBuild !== build) {
    throw new Error(
      `WDA ${kind} cache built with Xcode ${manifest.xcodeBuild}, current is ${build} — ${setupHint(kind)}`,
    );
  }
  if (!(await Bun.file(manifest.xctestrun).exists())) {
    throw new Error(
      `Cached xctestrun missing (${manifest.xctestrun}) — ${setupHint(kind)}`,
    );
  }
  // A device can only run a runner whose signing profile provisions it. Catch
  // that here, where the fix is one setup re-run, instead of inside xcodebuild.
  if (kind === "device" && udid && manifest.provisionedDevices?.length) {
    const provisioned = manifest.provisionedDevices.some(
      (d) => d.toLowerCase() === udid.toLowerCase(),
    );
    if (!provisioned) {
      throw new Error(
        `Device ${udid} is not provisioned by the profile the cached WDA was signed with ` +
          `("${manifest.profileName ?? "unknown"}"). Register the device in Xcode, then ${setupHint("device")}.`,
      );
    }
  }
  return manifest;
}

async function isHealthy(client: WdaClient): Promise<boolean> {
  try {
    const status = await client.status();
    return status?.ready !== false; // WDA reports { ready: true, ... }
  } catch {
    return false;
  }
}

/**
 * The env of the xcodebuild process does NOT reach the test runner (verified on
 * Xcode 26) — the port must be baked into the .xctestrun's EnvironmentVariables
 * instead. The copy must live in the same directory as the original so its
 * __TESTROOT__ paths still resolve.
 */
async function prepareXctestrun(
  xctestrun: string,
  port: number,
): Promise<string> {
  const copy = xctestrun.replace(/\.xctestrun$/, `-port${port}.xctestrun`);
  await Bun.write(copy, Bun.file(xctestrun));
  const proc = Bun.spawn(
    [
      "/usr/libexec/PlistBuddy",
      "-c",
      `Set :WebDriverAgentRunner:EnvironmentVariables:USE_PORT ${port}`,
      copy,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Could not set USE_PORT in ${copy}: ${err.trim()}`);
  }
  return copy;
}

function logPathFor(udid: string): string {
  return join(CACHE_ROOT, `wda-${udid}.log`);
}

/**
 * Launch the runner. `wdaPort` is the port WDA binds ON THE TARGET — the same
 * as the local port for a simulator, always DEVICE_WDA_PORT for a phone (where
 * a tunnel bridges the difference).
 */
async function spawnRunner(
  xctestrun: string,
  udid: string,
  wdaPort: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  // Start clean so discoverServerUrl can never read a previous run's address.
  await Bun.write(logPathFor(udid), "");
  const logFile = Bun.file(logPathFor(udid));
  const runFile = await prepareXctestrun(xctestrun, wdaPort);
  const child = Bun.spawn(
    [
      "xcodebuild",
      "test-without-building",
      "-xctestrun",
      runFile,
      "-destination",
      `id=${udid}`,
    ],
    { stdout: logFile, stderr: logFile },
  );
  // Don't let the runner hold this process's event loop open — the `exit`
  // handler (shutdownWda) still kills it when we terminate.
  child.unref();
  return child;
}

/**
 * Is this device visible to usbmuxd (i.e. attached by cable and trusted)?
 *
 * Only then can `iproxy` forward a port. A device paired over the local network
 * is invisible to usbmux even though `devicectl` talks to it happily — so this
 * decides which reachability path a device gets, and never blocks one.
 */
async function usbmuxSees(udid: string): Promise<boolean> {
  const { stdout, exitCode } = await (async () => {
    const proc = Bun.spawn(["idevice_id", "-l"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout: out, exitCode: code };
  })().catch(() => ({ stdout: "", exitCode: 1 })); // iproxy/libimobiledevice absent
  if (exitCode !== 0) return false;
  return stdout
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .includes(udid.toLowerCase());
}

/** Forward localhost:<localPort> to <device>:8100 over usbmux. */
async function spawnTunnel(
  udid: string,
  localPort: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn(
    ["iproxy", `${localPort}:${DEVICE_WDA_PORT}`, "-u", udid],
    { stdout: "pipe", stderr: "pipe" },
  );
  child.unref();
  await Bun.sleep(300);
  if (child.exitCode !== null) {
    const err = (await new Response(child.stderr).text()).trim();
    throw new Error(
      `iproxy could not forward ${localPort} to ${udid}:${DEVICE_WDA_PORT} ` +
        `(exited ${child.exitCode}${err ? `: ${err}` : ""}).`,
    );
  }
  return child;
}

/**
 * Read the address WDA bound to out of the runner log.
 *
 * WDA announces itself as `ServerURLHere->http://…:8100<-ServerURLHere`. On a
 * device that address is the phone's own LAN IP, which is the ONLY way to reach
 * it without a cable — Xcode 26 launches the runner over CoreDevice's network
 * link, so a WDA on a Wi-Fi-paired phone is live but not on any localhost port.
 *
 * The log is truncated before each launch; otherwise a stale URL from a
 * previous run reads as success and every request goes to a dead address.
 */
async function discoverServerUrl(
  logPath: string,
  deadline: number,
  isAlive: () => boolean,
): Promise<string | null> {
  const re = /ServerURLHere->(\S+?)<-ServerURLHere/;
  while (Date.now() < deadline) {
    const text = await Bun.file(logPath).text().catch(() => "");
    const match = text.match(re);
    if (match) return match[1];
    if (!isAlive()) return null;
    await Bun.sleep(1_000);
  }
  return null;
}

/**
 * Ensure a healthy WDA is running for this target and return its client.
 *
 * Simulators boot on demand; devices must already be connected. A live runner
 * is reused, a dead one relaunched. Devices get a longer readiness budget: the
 * first run also installs the runner app over the cable.
 */
export async function ensureWda(target: WdaTarget | string): Promise<WdaClient> {
  // A bare UDID keeps every v1 call site (all simulators) working unchanged.
  const { kind, udid }: WdaTarget =
    typeof target === "string" ? { kind: "sim", udid: target } : target;

  if (kind === "sim") await ensureBooted(udid);

  let instance = registry.get(udid);
  if (!instance) {
    const port = portFor(udid);
    instance = {
      udid,
      kind,
      port,
      client: new WdaClient(udid, port),
      child: null,
      tunnel: null,
      // A simulator's endpoint is known up front; a device's is not.
      resolved: kind === "sim",
    };
    registry.set(udid, instance);
  }

  if (instance.resolved && (await isHealthy(instance.client))) {
    return instance.client;
  }

  // Dead or never started — (re)launch from the cached build.
  instance.client.invalidateSession();
  if (instance.child) {
    instance.child.kill();
    instance.child = null;
  }
  if (instance.tunnel) {
    instance.tunnel.kill();
    instance.tunnel = null;
  }

  const manifest = await loadManifest(kind, kind === "device" ? udid : undefined);
  const wdaPort = kind === "device" ? DEVICE_WDA_PORT : instance.port;
  instance.child = await spawnRunner(manifest.xctestrun, udid, wdaPort);

  const budgetMs = kind === "device" ? 120_000 : 60_000;
  const deadline = Date.now() + budgetMs;

  if (kind === "device") {
    // Wait for WDA to say where it is before deciding how to reach it.
    const child = instance.child;
    const announced = await discoverServerUrl(
      logPathFor(udid),
      deadline,
      () => child.exitCode === null,
    );
    if (!announced) {
      instance.child.kill();
      instance.child = null;
      throw new Error(
        `WDA never announced its address on ${udid} within ${budgetMs / 1000}s ` +
          `(runner ${child.exitCode === null ? "still running" : `exited ${child.exitCode}`}) — ` +
          `log: ${logPathFor(udid)}`,
      );
    }
    // A cable is the sturdier route when it exists (no LAN, no client
    // isolation); otherwise talk straight to the phone's announced address.
    if (await usbmuxSees(udid)) {
      instance.tunnel = await spawnTunnel(udid, instance.port);
      instance.client.baseUrl = `http://localhost:${instance.port}`;
    } else {
      instance.client.baseUrl = announced;
    }
    instance.resolved = true;
  }

  while (Date.now() < deadline) {
    if (await isHealthy(instance.client)) return instance.client;
    if (instance.child.exitCode !== null) {
      throw new Error(
        `WDA runner exited early (code ${instance.child.exitCode}) — log: ${logPathFor(udid)}`,
      );
    }
    await Bun.sleep(1_000);
  }
  instance.child.kill();
  instance.child = null;
  instance.tunnel?.kill();
  instance.tunnel = null;
  instance.resolved = kind === "sim";
  throw new Error(
    `WDA did not become ready at ${instance.client.baseUrl} within ${budgetMs / 1000}s — log: ${logPathFor(udid)}`,
  );
}

/** Kill every WDA runner and tunnel this process spawned. Safe to repeat. */
export function shutdownWda(): void {
  for (const instance of registry.values()) {
    instance.child?.kill();
    instance.child = null;
    instance.tunnel?.kill();
    instance.tunnel = null;
    instance.resolved = instance.kind === "sim";
  }
}

/**
 * Orphan sweep: kill any `xcodebuild … WebDriverAgentRunner` process whose
 * target is gone — a simulator that is no longer booted, or a device that is no
 * longer connected. Call once on server startup.
 */
export async function killOrphanWda(): Promise<number> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const live = new Set(
    (await listDevices())
      .filter((d) => d.state === "Booted")
      .map((d) => d.udid.toLowerCase()),
  );
  // Physical devices have no "booted" state — connected is the equivalent.
  for (const d of await listPhysicalDevices().catch(() => [])) {
    if (d.available) live.add(d.udid.toLowerCase());
  }

  let killed = 0;
  for (const line of out.split("\n")) {
    if (!line.includes("xcodebuild") || !line.includes("WebDriverAgentRunner"))
      continue;
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    // Simulator UDIDs are 36-char UUIDs; device UDIDs are 25 chars with a dash.
    const udid = line.match(/id=([0-9A-Fa-f-]{24,40})/)?.[1];
    if (!pid || pid === process.pid) continue;
    if (udid && live.has(udid.toLowerCase())) continue; // legitimate runner
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      // already gone
    }
  }
  return killed;
}

// Teardown: never leave spawned runners behind.
process.on("SIGTERM", () => {
  shutdownWda();
  process.exit(143);
});
process.on("SIGINT", () => {
  shutdownWda();
  process.exit(130);
});
process.on("exit", shutdownWda);
