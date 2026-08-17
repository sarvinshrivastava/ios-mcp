/**
 * wda.ts — WebDriverAgent lifecycle + HTTP client.
 *
 * One WDA instance per simulator UDID, each on its own port (base
 * IOS_MCP_WDA_PORT_BASE, default 8100). The runner is launched with
 * `xcodebuild test-without-building` against the .xctestrun cached by
 * `bun run setup`, health-checked over plain HTTP, and reused across calls.
 * All driving happens over fetch — no Appium server, no client library.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { ensureBooted, listDevices, xcrun } from "./simctl.ts";

const PORT_BASE = parseInt(process.env.IOS_MCP_WDA_PORT_BASE || "8100", 10);
const CACHE_ROOT =
  process.env.IOS_MCP_WDA_HOME || join(homedir(), ".cache", "ios-mcp", "wda");

const SETUP_HINT = "re-run `bun run setup`";

interface WdaManifest {
  xcodeVersion: string;
  xcodeBuild: string;
  xctestrun: string;
  builtAt: string;
}

interface WdaInstance {
  udid: string;
  port: number;
  client: WdaClient;
  /** Child handle when this server spawned the runner; null when reusing. */
  child: ReturnType<typeof Bun.spawn> | null;
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
  readonly baseUrl: string;
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

async function loadManifest(): Promise<WdaManifest> {
  const { stdout, exitCode } = await xcrun(["xcodebuild", "-version"]);
  const build = exitCode === 0 && stdout.match(/^Build version (\S+)$/m)?.[1];
  if (!build)
    throw new Error(
      "Could not read Xcode version (xcodebuild -version failed)",
    );
  const manifestPath = join(CACHE_ROOT, build, "manifest.json");
  const manifest = (await Bun.file(manifestPath)
    .json()
    .catch(() => null)) as WdaManifest | null;
  if (!manifest) {
    throw new Error(
      `No WDA build cached for Xcode build ${build} — ${SETUP_HINT}`,
    );
  }
  if (manifest.xcodeBuild !== build) {
    throw new Error(
      `WDA cache built with Xcode ${manifest.xcodeBuild}, current is ${build} — ${SETUP_HINT}`,
    );
  }
  if (!(await Bun.file(manifest.xctestrun).exists())) {
    throw new Error(
      `Cached xctestrun missing (${manifest.xctestrun}) — ${SETUP_HINT}`,
    );
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
 * The env of the xcodebuild process does NOT reach the test runner on the
 * simulator (verified on Xcode 26) — the port must be baked into the
 * .xctestrun's EnvironmentVariables instead. The copy must live in the same
 * directory as the original so its __TESTROOT__ paths still resolve.
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

async function spawnRunner(
  xctestrun: string,
  udid: string,
  port: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  const logPath = join(CACHE_ROOT, `wda-${udid}.log`);
  const logFile = Bun.file(logPath);
  const runFile = await prepareXctestrun(xctestrun, port);
  const child = Bun.spawn(
    [
      "xcodebuild",
      "test-without-building",
      "-xctestrun",
      runFile,
      "-destination",
      `id=${udid}`,
    ],
    {
      stdout: logFile,
      stderr: logFile,
    },
  );
  // Don't let the runner hold this process's event loop open — the `exit`
  // handler (shutdownWda) still kills it when we terminate.
  child.unref();
  return child;
}

/**
 * Ensure a healthy WDA is running for this UDID and return its client.
 * Boots the sim if needed; reuses a live runner; otherwise launches one and
 * polls /status until ready (60 s).
 */
export async function ensureWda(udid: string): Promise<WdaClient> {
  await ensureBooted(udid);

  let instance = registry.get(udid);
  if (!instance) {
    const port = portFor(udid);
    instance = { udid, port, client: new WdaClient(udid, port), child: null };
    registry.set(udid, instance);
  }

  if (await isHealthy(instance.client)) return instance.client;

  // Dead or never started — (re)launch from the cached build.
  instance.client.invalidateSession();
  if (instance.child) {
    instance.child.kill();
    instance.child = null;
  }
  const manifest = await loadManifest();
  instance.child = await spawnRunner(manifest.xctestrun, udid, instance.port);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isHealthy(instance.client)) return instance.client;
    if (instance.child.exitCode !== null) {
      throw new Error(
        `WDA runner exited early (code ${instance.child.exitCode}) — log: ${join(CACHE_ROOT, `wda-${udid}.log`)}`,
      );
    }
    await Bun.sleep(1_000);
  }
  instance.child.kill();
  instance.child = null;
  throw new Error(
    `WDA did not become ready on port ${instance.port} within 60s — log: ${join(CACHE_ROOT, `wda-${udid}.log`)}`,
  );
}

/** Kill every WDA runner this process spawned. Safe to call repeatedly. */
export function shutdownWda(): void {
  for (const instance of registry.values()) {
    if (instance.child) {
      instance.child.kill();
      instance.child = null;
    }
  }
}

/**
 * Orphan sweep: kill any `xcodebuild … WebDriverAgentRunner` process whose
 * target UDID no longer has a booted simulator. Call once on server startup.
 */
export async function killOrphanWda(): Promise<number> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const booted = new Set(
    (await listDevices())
      .filter((d) => d.state === "Booted")
      .map((d) => d.udid),
  );

  let killed = 0;
  for (const line of out.split("\n")) {
    if (!line.includes("xcodebuild") || !line.includes("WebDriverAgentRunner"))
      continue;
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    const udid = line.match(/id=([0-9A-Fa-f-]{36})/)?.[1];
    if (!pid || pid === process.pid) continue;
    if (udid && booted.has(udid)) continue; // legitimate runner, leave it
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
