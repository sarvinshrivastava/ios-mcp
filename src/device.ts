/**
 * device.ts — WDA-free test utilities that earn their place by condensing or
 * composing, never by 1:1 wrapping a simctl command.
 *
 *   read_syslog → predicate-filters the unified-log firehose down to one app's
 *                 lines and auto-flags crashes from ~/Library/Logs/DiagnosticReports.
 *   reset_app   → terminate + wipe data container + relaunch (a test concept,
 *                 three commands), with an optional full reinstall.
 *
 * (`current_app` also lives here per the spec, but it needs WDA's
 * /wda/activeAppInfo — added at integration by the WDA layer.)
 */

import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { launchApp, run, simctl, terminateApp } from "./simctl.ts";

/**
 * Resolve a bundle id to its executable name (what the unified log calls the
 * process). `simctl appinfo` prints an old-style plist — one regex line pull
 * beats a plutil round-trip and works for system and user apps alike.
 * Verified on Xcode 26.6: `CFBundleExecutable = Preferences;` (quoted when the
 * name has spaces/dots).
 */
async function executableName(udid: string, bundleId: string): Promise<string> {
  const info = await simctl(udid, ["appinfo", udid, bundleId]);
  const m = info.match(/CFBundleExecutable\s*=\s*"?([^";\n]+)"?\s*;/);
  if (!m) {
    throw new Error(
      `Could not resolve executable for ${bundleId} — is it installed? (simctl appinfo returned no CFBundleExecutable)`,
    );
  }
  return m[1].trim();
}

export interface CrashReport {
  /** Absolute path of the .ips report. */
  path: string;
  /** Best-effort one-line reason (exception type/message or termination indicator). */
  reason: string;
  /** ISO timestamp of the crash (report header, else file mtime). */
  at: string;
}

export interface SyslogOptions {
  /** Restrict to one app's process via NSPredicate on its executable path. */
  bundleId?: string;
  /** Case-insensitive substring filter applied to the returned lines. */
  filter?: string;
  /** How far back to read. Default 120. */
  sinceSeconds?: number;
  /** Max lines returned (most recent kept). Default and hard cap: 200. */
  lines?: number;
}

/**
 * Read the simulator's unified log, condensed: time-bounded, app-scoped, and
 * line-capped — never the raw firehose.
 *
 * Predicate note (learned on this machine): `processImagePath CONTAINS "<exe>"`
 * has false positives — e.g. "Preferences" also matches localizationswitcherd,
 * which lives inside IntlPreferences.framework. `ENDSWITH "/<exe>"` matches the
 * binary itself and nothing else.
 */
export async function readSyslog(
  udid: string,
  opts: SyslogOptions = {},
): Promise<{ lines: string[]; crashes: CrashReport[] }> {
  const sinceSeconds = Math.max(1, opts.sinceSeconds ?? 120);
  const cap = Math.min(Math.max(1, opts.lines ?? 200), 200);

  const args = [
    "spawn",
    udid,
    "log",
    "show",
    "--last",
    `${sinceSeconds}s`,
    "--style",
    "compact",
  ];
  let executable: string | undefined;
  if (opts.bundleId) {
    executable = await executableName(udid, opts.bundleId);
    // NSPredicate string literal — escape backslashes and double quotes.
    const escaped = executable.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    args.push("--predicate", `processImagePath ENDSWITH "/${escaped}"`);
  }

  // `log show` walks the whole window server-side; scale the timeout with it.
  const timeoutMs = Math.min(60_000 + sinceSeconds * 100, 300_000);
  const out = await run(args, timeoutMs);

  let lines = out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    // Drop the column-header line log show prints first.
    .filter((l) => !/^Timestamp\s+/.test(l));
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(f));
  }

  const crashes = executable
    ? await scanCrashReports(udid, executable, sinceSeconds)
    : [];

  return { lines: lines.slice(-cap), crashes };
}

/**
 * Scan ~/Library/Logs/DiagnosticReports for .ips crash reports newer than the
 * log window that belong to this process on this simulator.
 *
 * .ips format (verified on macOS 26): line 1 is a small JSON header
 * (app_name/name/timestamp/bundleID), the remainder is a pretty-printed JSON
 * body (procName, procPath, exception{type,subtype,message}, termination
 * {namespace,indicator}). Both halves are parsed defensively — a half-written
 * or format-shifted report degrades to filename matching, never a throw.
 */
async function scanCrashReports(
  udid: string,
  executable: string,
  sinceSeconds: number,
): Promise<CrashReport[]> {
  const dir = join(homedir(), "Library", "Logs", "DiagnosticReports");
  const cutoff = Date.now() - sinceSeconds * 1000;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no reports dir — nothing has ever crashed
  }

  const crashes: CrashReport[] = [];
  for (const name of names) {
    if (!name.endsWith(".ips")) continue;
    const path = join(dir, name);

    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) continue;

    let header: Record<string, unknown> = {};
    let body: Record<string, unknown> = {};
    try {
      const raw = await Bun.file(path).text();
      const nl = raw.indexOf("\n");
      try {
        header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
      } catch {
        /* header unreadable — fall through to filename match */
      }
      if (nl !== -1) {
        try {
          body = JSON.parse(raw.slice(nl));
        } catch {
          /* body unreadable — header may still identify the process */
        }
      }
    } catch {
      continue; // unreadable file (permissions) — skip
    }

    // Does this report belong to our process?
    const procName =
      (body.procName as string) ||
      (header.name as string) ||
      (header.app_name as string) ||
      "";
    const matchesName = procName === executable || name.includes(executable);
    if (!matchesName) continue;

    // …and to our simulator? procPath/coalitionName embed the sim UDID. Only
    // exclude on a POSITIVE mismatch — absent fields stay included.
    const procPath = (body.procPath as string) || "";
    const coalition = (body.coalitionName as string) || "";
    const udidRe = /[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}/i;
    const pathUdid =
      procPath.match(udidRe)?.[0] || coalition.match(udidRe)?.[0];
    if (pathUdid && pathUdid.toUpperCase() !== udid.toUpperCase()) continue;

    crashes.push({
      path,
      reason: crashReason(header, body),
      at: crashTimestamp(header, mtime),
    });
  }
  return crashes.sort((a, b) => a.at.localeCompare(b.at));
}

/** One line that tells the agent WHY it crashed, best field available first. */
function crashReason(
  header: Record<string, unknown>,
  body: Record<string, unknown>,
): string {
  const exc = body.exception as
    | { type?: string; subtype?: string; message?: string; signal?: string }
    | undefined;
  if (exc?.type) {
    const parts = [exc.type];
    if (exc.signal) parts.push(`(${exc.signal})`);
    else if (exc.subtype) parts.push(`(${exc.subtype})`);
    if (exc.message) parts.push(`— ${exc.message}`);
    return parts.join(" ");
  }
  const term = body.termination as
    { indicator?: string; namespace?: string } | undefined;
  if (term?.indicator) {
    return term.namespace
      ? `${term.namespace}: ${term.indicator}`
      : term.indicator;
  }
  if (header.bug_type) return `bug_type ${header.bug_type}`;
  return "unknown (open the report)";
}

/** Crash time: header `timestamp` ("2026-08-17 10:54:02.00 +0530"), else mtime. */
function crashTimestamp(
  header: Record<string, unknown>,
  mtimeMs: number,
): string {
  const ts = header.timestamp as string | undefined;
  if (ts) {
    // "2026-08-17 10:54:02.00 +0530" — drop the nonstandard fraction, T-join
    // date and time, glue the offset on: "2026-08-17T10:54:02+0530".
    const norm = ts
      .replace(/\.\d+(?= )/, "")
      .replace(" ", "T")
      .replace(" ", "");
    const parsed = Date.parse(norm);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(mtimeMs).toISOString();
}

export interface ResetAppOptions {
  /** Uninstall + install `appPath` instead of wiping the data container. */
  reinstall?: boolean;
  /** Path to the .app bundle — required when `reinstall` is true. */
  appPath?: string;
}

/**
 * Restore an app to a fresh first-run state and relaunch it.
 *
 * Default: terminate → empty the data container's Documents/Library/tmp
 * (contents only — the dirs themselves must survive) → launch. With
 * `reinstall`: uninstall → install → launch, for apps whose first-run state
 * lives in Keychain or app-group containers a data wipe can't reach.
 */
export async function resetApp(
  udid: string,
  bundleId: string,
  opts: ResetAppOptions = {},
): Promise<{ cleared: boolean; reinstalled: boolean; pid: number }> {
  if (opts.reinstall) {
    if (!opts.appPath) {
      throw new Error(
        "reset_app with reinstall: true requires appPath (the .app bundle to install)",
      );
    }
    await terminateApp(udid, bundleId);
    await simctl(udid, ["uninstall", udid, bundleId]);
    await simctl(udid, ["install", udid, opts.appPath]);
    const pid = await launchApp(udid, bundleId);
    return { cleared: true, reinstalled: true, pid };
  }

  await terminateApp(udid, bundleId);

  const container = (
    await simctl(udid, ["get_app_container", udid, bundleId, "data"])
  ).trim();
  // System apps have no data container: simctl prints "(null)" and EXITS 0.
  // Guard hard before any delete — we only ever rm INSIDE a real container.
  if (
    !container ||
    container === "(null)" ||
    !isAbsolute(container) ||
    !container.includes("/data/Containers/")
  ) {
    throw new Error(
      `Refusing to wipe: "${container}" is not an app data container path for ${bundleId}`,
    );
  }

  // Empty Documents/Library/tmp — delete their CONTENTS, keep the dirs (the
  // app expects the skeleton to exist on next launch).
  for (const sub of ["Documents", "Library", "tmp"]) {
    const subdir = join(container, sub);
    let entries: string[];
    try {
      entries = await readdir(subdir);
    } catch {
      continue; // missing subdir — nothing to wipe
    }
    for (const entry of entries) {
      await rm(join(subdir, entry), { recursive: true, force: true });
    }
  }

  const pid = await launchApp(udid, bundleId);
  return { cleared: true, reinstalled: false, pid };
}
