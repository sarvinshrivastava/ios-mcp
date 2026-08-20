/**
 * signing.ts — find the local code-signing assets a real-device WDA build needs.
 *
 * Real devices need a signed WebDriverAgentRunner; simulators need nothing.
 * This module answers one question — "which identity + provisioning profile
 * already on this Mac can sign WDA for THIS device?" — by reading the keychain
 * and the on-disk profiles only.
 *
 * HARD RULE: nothing here (or in setup) may reach Apple's cloud. No
 * `-allowProvisioningUpdates`, no portal calls — that flag registers devices
 * and mints profiles server-side, which this project is not allowed to do. If
 * no local asset matches, we fail with a message that names the missing piece
 * so a human can fix it in Xcode.
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** WDA's test-runner app bundle id — the only bundle a profile must cover. */
export const WDA_RUNNER_BUNDLE_ID =
  "com.facebook.WebDriverAgentRunner.xctrunner";

/** Xcode 16+ keeps profiles here; older Xcodes used the MobileDevice path. */
function profileDirs(): string[] {
  return [
    join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
    join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
  ];
}

export interface CodesignIdentity {
  /** SHA-1 hash — the unambiguous way to name an identity to xcodebuild. */
  sha1: string;
  /** e.g. "Apple Development: Sarvin Shrivastava (S2TQ4JYYND)" */
  name: string;
  /** Team id, read from the certificate's OU field. */
  teamId: string;
}

export interface Profile {
  path: string;
  name: string;
  uuid: string;
  teamId: string;
  /** Entitlement `application-identifier`, e.g. "2TJ9K965G7.*". */
  appIdentifier: string;
  /** Development profiles have get-task-allow; distribution ones don't. */
  development: boolean;
  expiresAt: Date;
  /** Device UDIDs the profile provisions (absent for App Store profiles). */
  devices: string[];
}

export interface SigningAssets {
  identity: CodesignIdentity;
  profile: Profile;
}

async function sh(cmd: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { out, code };
}

// ---------------------------------------------------------------------------
// Keychain identities
// ---------------------------------------------------------------------------

/**
 * All codesigning identities, each tagged with its team id.
 *
 * The team id is NOT in the identity's display name — the parenthesized string
 * there is the certificate id. It lives in the certificate subject's OU, so we
 * read the cert back out of the keychain per identity.
 */
export async function listIdentities(): Promise<CodesignIdentity[]> {
  const { out } = await sh(["security", "find-identity", "-v", "-p", "codesigning"]);
  const identities: CodesignIdentity[] = [];
  // `  1) A1B2C3… "Apple Development: Name (ABCDE12345)"`
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/);
    if (!m) continue;
    const [, sha1, name] = m;
    const teamId = await teamIdOf(name);
    if (teamId) identities.push({ sha1, name, teamId });
  }
  return identities;
}

/** Team id from a certificate's subject OU, via openssl. */
async function teamIdOf(certName: string): Promise<string | null> {
  const pem = await sh(["security", "find-certificate", "-c", certName, "-p"]);
  if (pem.code !== 0 || !pem.out.includes("BEGIN CERTIFICATE")) return null;
  const proc = Bun.spawn(["openssl", "x509", "-noout", "-subject"], {
    stdin: new TextEncoder().encode(pem.out),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [subject] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return subject.match(/OU\s*=\s*([A-Z0-9]+)/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Provisioning profiles
// ---------------------------------------------------------------------------

/**
 * Read one plist key out of decoded plist TEXT via `plutil -extract` on stdin.
 *
 * Whole-plist conversion is not an option: `plutil -convert json` fails on the
 * profile outright ("Invalid object in plist for JSON format") because JSON has
 * no date type and every profile carries CreationDate/ExpirationDate — and two
 * more keys hold raw DER bytes. Extracting the handful of keys we actually
 * match on side-steps both. A missing key exits nonzero and yields null.
 */
async function plistExtract(
  plist: string,
  key: string,
  format: "raw" | "json",
): Promise<string | null> {
  const proc = Bun.spawn(["plutil", "-extract", key, format, "-o", "-", "-"], {
    stdin: new TextEncoder().encode(plist),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) return null;
  return out.trim() || null;
}

/**
 * Decode one .mobileprovision (a CMS-signed plist) into the fields we match on.
 */
export async function readProfile(path: string): Promise<Profile | null> {
  const decoded = await sh(["security", "cms", "-D", "-i", path]);
  if (decoded.code !== 0 || !decoded.out.trim()) return null;
  const plist = decoded.out;

  const [name, uuid, expires, entitlementsJson, devicesJson] = await Promise.all([
    plistExtract(plist, "Name", "raw"),
    plistExtract(plist, "UUID", "raw"),
    plistExtract(plist, "ExpirationDate", "raw"),
    plistExtract(plist, "Entitlements", "json"),
    plistExtract(plist, "ProvisionedDevices", "json"),
  ]);
  if (!name || !uuid || !entitlementsJson) return null;

  let entitlements: Record<string, unknown>;
  let devices: string[] = [];
  try {
    entitlements = JSON.parse(entitlementsJson);
    if (devicesJson) devices = JSON.parse(devicesJson) as string[];
  } catch {
    return null;
  }

  const appId = entitlements["application-identifier"];
  if (typeof appId !== "string") return null;

  return {
    path,
    name,
    uuid,
    teamId:
      (entitlements["com.apple.developer.team-identifier"] as string) ??
      appId.split(".")[0],
    appIdentifier: appId,
    development: entitlements["get-task-allow"] === true,
    // `raw` prints an ISO-8601 date ("2027-07-14T10:21:58Z").
    expiresAt: new Date(expires ?? 0),
    devices,
  };
}

/** Every readable profile on this Mac, newest expiry first. */
export async function listProfiles(): Promise<Profile[]> {
  const profiles: Profile[] = [];
  for (const dir of profileDirs()) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".mobileprovision") && !name.endsWith(".provisionprofile")) continue;
      const profile = await readProfile(join(dir, name));
      if (profile) profiles.push(profile);
    }
  }
  return profiles.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
}

/**
 * Does this profile's application-identifier cover `bundleId`?
 * A trailing `*` is the only wildcard Apple allows, and it matches any suffix.
 */
export function coversBundleId(profile: Profile, bundleId: string): boolean {
  const appId = profile.appIdentifier.slice(profile.teamId.length + 1); // strip "TEAM."
  if (appId === "*") return true;
  if (appId.endsWith(".*")) return bundleId.startsWith(appId.slice(0, -1));
  return appId === bundleId;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectOptions {
  /** Device UDID that must appear in the profile's ProvisionedDevices. */
  udid?: string;
  /** Bundle id the profile must cover. Defaults to WDA's runner app. */
  bundleId?: string;
}

/**
 * Pick the identity + profile to sign WDA with, or throw a message that names
 * the missing asset. Env overrides win: IOS_MCP_TEAM_ID, IOS_MCP_PROFILE_UUID,
 * IOS_MCP_SIGN_IDENTITY (name or SHA-1).
 */
export async function selectSigningAssets(
  opts: SelectOptions = {},
): Promise<SigningAssets> {
  const bundleId = opts.bundleId ?? WDA_RUNNER_BUNDLE_ID;
  const wantTeam = process.env.IOS_MCP_TEAM_ID;
  const wantProfile = process.env.IOS_MCP_PROFILE_UUID;
  const wantIdentity = process.env.IOS_MCP_SIGN_IDENTITY;

  const identities = (await listIdentities()).filter(
    (i) =>
      (!wantTeam || i.teamId === wantTeam) &&
      (!wantIdentity || i.name === wantIdentity || i.sha1 === wantIdentity),
  );
  if (identities.length === 0) {
    throw new Error(
      "No usable code-signing identity in the keychain" +
        (wantTeam ? ` for team ${wantTeam}` : "") +
        (wantIdentity ? ` matching IOS_MCP_SIGN_IDENTITY=${wantIdentity}` : "") +
        ". Add an Apple Development certificate in Xcode → Settings → Accounts, " +
        "then re-run `bun run setup --device`.",
    );
  }

  const now = Date.now();
  const all = await listProfiles();
  const candidates = all.filter(
    (p) =>
      (!wantProfile || p.uuid === wantProfile || p.name === wantProfile) &&
      p.expiresAt.getTime() > now &&
      p.development &&
      coversBundleId(p, bundleId) &&
      identities.some((i) => i.teamId === p.teamId) &&
      (!opts.udid ||
        p.devices.some((d) => d.toLowerCase() === opts.udid!.toLowerCase())),
  );

  if (candidates.length === 0) throw noProfileError(all, identities, opts, bundleId, now);

  // Prefer a wildcard profile (it keeps working when WDA's bundle id changes),
  // then the one that expires last.
  const profile =
    candidates.find((p) => coversBundleId(p, "any.bundle.id.at.all")) ?? candidates[0];
  const identity = identities.find((i) => i.teamId === profile.teamId)!;
  return { identity, profile };
}

/** Diagnose WHY nothing matched — the failure mode a human has to act on. */
function noProfileError(
  all: Profile[],
  identities: CodesignIdentity[],
  opts: SelectOptions,
  bundleId: string,
  now: number,
): Error {
  const teams = [...new Set(identities.map((i) => i.teamId))];
  const reasons: string[] = [];
  const covering = all.filter((p) => coversBundleId(p, bundleId));

  if (all.length === 0) reasons.push("no provisioning profiles are installed on this Mac");
  else if (covering.length === 0)
    reasons.push(`no profile covers ${bundleId} (need a wildcard '*' app id or that exact id)`);
  else {
    const dev = covering.filter((p) => p.development);
    if (dev.length === 0) reasons.push("the covering profiles are all distribution (no get-task-allow)");
    const live = dev.filter((p) => p.expiresAt.getTime() > now);
    if (dev.length > 0 && live.length === 0) reasons.push("the covering development profiles are expired");
    const sameTeam = live.filter((p) => teams.includes(p.teamId));
    if (live.length > 0 && sameTeam.length === 0)
      reasons.push(
        `no keychain identity matches their teams (profiles: ${[...new Set(live.map((p) => p.teamId))].join(", ")}; identities: ${teams.join(", ")})`,
      );
    if (opts.udid && sameTeam.length > 0)
      reasons.push(
        `device ${opts.udid} is not in any of them — register it in Xcode (open the device once with a signed app) and re-run setup`,
      );
  }

  return new Error(
    `Cannot sign WebDriverAgent for a real device: ${reasons.join("; ")}. ` +
      "This project never contacts Apple's Developer portal " +
      "(`-allowProvisioningUpdates` is deliberately not used), so the profile must already exist locally. " +
      "Override selection with IOS_MCP_TEAM_ID / IOS_MCP_PROFILE_UUID / IOS_MCP_SIGN_IDENTITY.",
  );
}
