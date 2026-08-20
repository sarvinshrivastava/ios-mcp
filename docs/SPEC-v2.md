# ios-mcp v2 — Design Spec

**Date:** 2026-08-20
**Status:** Implemented (P0–P3); device-side field verification pending a
reachable phone. See "Outcomes vs. plan" at the end for where reality differed.
**Builds on:** [`SPEC.md`](SPEC.md) (v1, simulator-only, shipped)

---

## Goal

Three things, in priority order:

1. **Real devices.** Every one of the 14 v1 tools works against a physically
   connected iPhone, not just a simulator — the work v1's spec deferred
   ("signing + `devicectl` + port forward — no rewrite").
2. **One capture path.** Screenshots come from WDA on both backends instead of
   `simctl io`, so a device needs no second implementation.
3. **Two new tools:** `visual_diff` (regression comparison) and `record_screen`
   (flow capture) — the android-mcp roadmap parity items.

Out of scope (deliberately): stitched full-page screenshots (permanently
rejected), 1:1 `devicectl` wrappers, perf snapshots, wireless (network) devices.

**Dropped from the original v2 ask:** porting tree-driven `full_page_screenshot`
back to android-mcp. Verified 2026-08-20 — android-mcp
`src/screenshot.ts:90` already ships it (seen-labels set, `bottomDetectedBy:
"tree" | "pixel"`, pixel fallback when the tree vanishes). Nothing to port.

---

## Verified preconditions (measured on this machine, 2026-08-20)

| Fact | Value |
|---|---|
| Target device | Himanshu's iPhone — iPhone 12 (`iPhone13,2`), iOS 27.0 (24A5380h) |
| UDID / devicectl id | `00008101-0011685C1422001E` / `1F2B10B6-A456-59F7-8F86-DD08FD719910` |
| Transport / state | wired, `available (paired)`, booted, **Developer Mode enabled**, `ddiServicesAvailable: true` |
| Lock | `passcodeRequired: false`, `unlockedSinceBoot: true` (WDA needs an unlocked screen) |
| Signing identity | `Apple Development: Sarvin Shrivastava (S2TQ4JYYND)`, OU `2TJ9K965G7`, valid to 2027-07-08 |
| Profile | `iOS Team Provisioning Profile: *` — `2TJ9K965G7.*` wildcard, 16 devices **incl. this UDID**, valid to 2027-07-14, `IsXcodeManaged` |
| Tooling | Xcode 26.6 (17F113), `iproxy` at `/opt/homebrew/bin/iproxy`, `ffmpeg` 9.0.1 |
| Verification apps on device | `com.nidraapp.yoga.sleep` (Nidra 1.4.4), `com.habuild.yatraready` (Char Dham Ready 3.2.13) |

**Signing is local-only.** A matching cert + a wildcard profile that already
contains the device exist on disk, so WDA can be signed with
`PROVISIONING_PROFILE_SPECIFIER` and **no** Developer Portal mutation.
`xcodebuild -allowProvisioningUpdates` is **forbidden** in this repo — it
registers devices / creates profiles in Apple's cloud, which the operator's
restricted-Apple-cloud-push policy prohibits. If no local profile matches,
setup **fails with instructions** rather than reaching for the portal.

---

## Architecture change: one target abstraction, two backends

v1 assumes "target = simulator UDID" and calls `simctl` from four modules
(`simctl.ts`, `screenshot.ts`, `device.ts`, `wda.ts`). v2 puts a seam in front
of that.

```
index.ts (MCP tools)         ← unchanged tool contracts
   │
   ├── target.ts             ← resolves ONE Target { kind: "sim" | "device", … }
   │
   ├── backend.ts  (NEW)     ← dispatch: launch / terminate / install / uninstall
   │                            / logs / crashes / reset / recorder
   │      ├── simctl.ts      (existing, unchanged surface)
   │      └── devicectl.ts   (NEW — xcrun devicectl, JSON output only)
   │
   ├── wda.ts                ← + device build cache, + iproxy tunnel, + /screenshot
   ├── screenshot.ts         ← capture via WDA (both backends), sim fallback
   ├── visualdiff.ts  (NEW)  ← sharp pixel compare + changed-region boxes
   └── recorder.ts    (NEW)  ← simctl recordVideo (sim) | MJPEG→ffmpeg (device)
```

`Target` is the only new concept an agent can observe, and only through
`list_devices` / `select_device` output:

```ts
interface Target {
  kind: "sim" | "device";
  udid: string;          // simulator UDID, or the device's real UDID
  name: string;
  iosVersion: string;
  state: "Booted" | "Shutdown" | "Connected" | "Unavailable";
  deviceCtlId?: string;  // devicectl's separate identifier (devices only)
}
```

### Device discovery & selection

- `list_devices` merges `simctl list devices --json` with
  `devicectl list devices --json-output <tmp>` (the **only** supported
  machine-readable interface — devicectl says so in its own help), tagging each
  row `kind`. Physical devices that are `unavailable` are listed but not
  selectable, with the reason.
- `select_device` accepts a UDID, a devicectl id, or a unique name substring
  across **both** kinds. Ambiguity across kinds is an error listing candidates
  (v1's rule, wider scope).
- Auto-target rule extends v1's: a single booted sim **or** a single connected
  device auto-targets; one of each is ambiguous → explicit `select_device`.
  `IOS_MCP_UDID` still pre-selects either kind.

### WDA on a real device

Same runner, same HTTP surface, three deltas:

1. **A second cached build.** `setup.ts` gains `--device`:
   `xcodebuild build-for-testing -destination 'generic/platform=iOS'` with
   `CODE_SIGN_STYLE=Manual`, `DEVELOPMENT_TEAM=<team>`,
   `CODE_SIGN_IDENTITY=<identity>`, `PROVISIONING_PROFILE_SPECIFIER=<uuid>`.
   Cached at `~/.cache/ios-mcp/wda/<xcode-build>/device/` next to the existing
   simulator cache, with its own manifest recording team + profile UUID +
   identity. Simulator setup stays `CODE_SIGNING_ALLOWED=NO` and is untouched.
2. **Signing-asset auto-discovery.** Scan
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles/*.mobileprovision`
   (Xcode 16+ location) and pick a profile that is unexpired, has
   `get-task-allow` (development), matches the WDA bundle ids (wildcard, or
   explicit `com.facebook.WebDriverAgentRunner*`), **contains the target
   device's UDID**, and whose team has a matching `Apple Development` identity
   in the keychain. Overrides: `IOS_MCP_TEAM_ID`, `IOS_MCP_PROFILE_UUID`,
   `IOS_MCP_SIGN_IDENTITY`. No match ⇒ a message naming exactly what was
   missing (no cert / no profile / device not in profile / expired).
3. **A tunnel.** WDA listens on port 8100 **on the device**; the server spawns
   `iproxy <localPort>:8100 -u <udid>` and health-checks
   `http://localhost:<localPort>/status` as before. The registry entry grows an
   `iproxy` child handle and separate `localPort` / `devicePort`; teardown and
   the orphan sweep kill both children. Device cold-start budget is **120 s**
   (vs 60 s on sim) — first-ever run also installs the runner app.

Everything downstream (`/source`, W3C actions, `/wda/keys`,
`/wda/activeAppInfo`, `/wda/screen`) is byte-identical on device, so
`uitree.ts` / `actions.ts` need **no** changes.

### Capture unified on WDA

`GET /screenshot` (base64 PNG, session-less) replaces `simctl io … screenshot`
for both backends: one code path, no `simctl` on device, and it already returns
device **pixels**, preserving v1's "agents only ever see screenshot pixels"
contract (`scale` still read from `/wda/screen`). Dimensions keep coming from
`sharp`, off the real file — correct in landscape.

A `simctl io` fallback stays **for simulators only**, used when WDA screenshot
fails, so v1's proven path is never fully lost. Failure on a device is an error,
not a silent alternative.

---

## Per-tool behavior on a real device

| Tool | Device path | Change |
|---|---|---|
| `list_devices` / `select_device` | `devicectl list devices` merged with simctl | new |
| `inspect_screen` / `find_element` / `tap` / `tap_xy` / `type_into` / `wait_for` / `scroll_until` / `full_page_screenshot` | WDA, unchanged | none (tunnel only) |
| `screenshot` | WDA `/screenshot` | unified |
| `current_app` | WDA `/wda/activeAppInfo` + `screenSignature` | none |
| `read_syslog` | `log collect --device-udid <udid> --last <s>s --output <tmp>.logarchive` → `log show <archive> --style compact --predicate 'processImagePath ENDSWITH "/<exe>"'`; executable name from `devicectl device info apps` | rewritten per backend |
| crash flagging | `devicectl device info files --domain-type systemCrashLogs` → `devicectl device copy from` the matching `.ips` → **existing** header/body parser, unchanged | new source, same parser |
| `reset_app` | `devicectl device uninstall app` → `devicectl device install app <appPath>` → `devicectl device process launch` | **reinstall-only** |
| `record_screen` | WDA MJPEG (device port 9100, tunneled) → `ffmpeg -f mjpeg … -c:v h264` | new |
| `visual_diff` | pure local image work, backend-agnostic | new |

**`reset_app` on a device cannot wipe a data container.** `devicectl device
copy` has `to`/`from` and no delete verb, so there is no supported way to empty
`Documents`/`Library`/`tmp` in place. On a device, `reset_app` therefore
**requires** `appPath` and does uninstall→install→launch; called without it, it
errors explaining why instead of silently doing something weaker. The simulator
path keeps its fast container wipe.

`log collect` needs the device unlocked and trusted, and takes seconds to tens
of seconds for a large window; the timeout scales with `sinceSeconds` (same
formula as v1) and the archive is written under `IOS_MCP_OUTPUT_DIR` and deleted
after `log show`.

---

## New tools (16 total)

### `visual_diff`

```
visual_diff({ before: string, after?: string, threshold?: number })
```

Compares two PNGs — `after` omitted means **capture the current screen now**,
which is the common "did my change move anything?" shape. Both images are
normalized to the smaller common size (a scale/orientation mismatch is reported,
not silently stretched). Returns:

- `diffPct` — share of pixels differing beyond `threshold` (default 10/255 per
  channel, tuned to ignore compression noise)
- `changedRegions` — bounding boxes in **screenshot pixels**, from a 16×16 cell
  grid with adjacent changed cells merged, capped at 12 boxes (largest first)
- `diffImagePath` — the `after` image with changed regions outlined
- `verdict` — `"identical" | "minor" | "changed"` so an agent can branch without
  interpreting a float

### `record_screen`

```
record_screen({ action: "start" | "stop", name?: string, maxSeconds?: number })
```

One tool, not two, because a recording is one resource with two edges. `start`
returns the output path and begins capture (auto-stopping at `maxSeconds`,
default 120, hard cap 600 so a forgotten recording can't fill the disk); `stop`
finalizes and returns `{ path, durationMs, sizeBytes, frames? }`. A second
`start` on the same target is an error naming the in-flight recording.

- **Simulator:** `simctl io <udid> recordVideo --codec h264 <path>`, stopped
  with `SIGINT` (the only signal that finalizes the container).
- **Device:** WDA's MJPEG server (device port 9100, tunneled by the same iproxy
  child) piped into `ffmpeg -f mjpeg -i http://localhost:<p> -c:v h264`.
  Framerate/quality set through WDA settings (`mjpegServerFramerate`,
  `mjpegScalingFactor`). Lower fidelity than the simulator's native encoder —
  documented, not hidden.

---

## Phased build plan

| Phase | Work | Exit criterion |
|---|---|---|
| **P0 — risk burn-down** | `devicectl.ts`, `backend.ts`, `Target` in `target.ts`, signing-asset discovery, `setup.ts --device`, iproxy tunnel in `wda.ts` | `GET /status` green over the tunnel against Himanshu's iPhone, from a cold cache |
| **P1 — see** | WDA `/screenshot` unification, `list_devices`/`select_device` across kinds | `inspect_screen` + `screenshot` + `find_element` clean on Nidra **on device**; simulator behavior unchanged |
| **P2 — act & inspect** | device `read_syslog` (+ `systemCrashLogs` pull), device `reset_app`, `current_app` verify | scripted flow (launch → `wait_for` → `tap` → `type_into`) passes on device; a real crash surfaces with reason + report path |
| **P3 — new tools** | `visualdiff.ts`, `recorder.ts`, tool registration | `visual_diff` catches a known UI change; `record_screen` produces a playable mp4 on **both** backends |
| **P4 — harden & document** | error-message pass, orphan/teardown for iproxy children, README + `learnings/` (device signing, iproxy on iOS 27, `log collect` cost), global CLAUDE.md iOS section update | full 16-tool matrix verified on device **and** sim; `bun run typecheck` + `bun test` green |

## Test plan

Unit (`bun test`, no hardware): profile-selection logic against fixture
`.mobileprovision` plists, `devicectl --json-output` parsing fixtures, log
predicate construction, `.ips` parsing (existing), `visual_diff` geometry
(synthetic images with known changed rectangles), recorder argv construction.

Integration (hardware, scripted): `scripts/verify-device.ts` — the P0→P2 chain
end to end on the connected iPhone; existing `verify-phase0.ts` /
`verify-integration.ts` keep proving the simulator path did not regress.

## Risks

| Risk | Handling |
|---|---|
| `iproxy` (usbmuxd) forwarding on iOS 27 unverified | P0's whole purpose. Fallback if it fails: `devicectl device process launch --console` is not a tunnel, so the real fallback is `pymobiledevice3`'s tunneld — a new dependency, decided only if P0 fails |
| WDA device build fails on signing (`PPQCheck`, bundle-id conflict) | Manual signing with an explicit profile UUID; failure message names the missing asset. **Never** `-allowProvisioningUpdates` |
| Device locks mid-run and WDA stalls | `passcodeRequired: false` on this device; a lock-state precheck via `devicectl device info lockState` turns a hang into a clear error |
| `log collect` slow / needs trust | Time-boxed, scaled timeout, archive cleaned up; error names the window that timed out |
| MJPEG recording quality on device | Documented as lower-fidelity; simulator keeps the native encoder |
| Two WDA caches drift after an Xcode upgrade | Both keyed by Xcode build version; each reports its own "re-run `bun run setup [--device]`" |


---

## Outcomes vs. plan

What the build changed about the design, and why:

| Plan said | Reality | Consequence |
|---|---|---|
| Manual signing with `PROVISIONING_PROFILE_SPECIFIER=<uuid>` | Xcode 26.6 refuses: an Xcode-managed profile "requires a manually managed profile", and naming a profile breaks `WebDriverAgentLib` ("does not support provisioning profiles") | Automatic style pinned to `DEVELOPMENT_TEAM`, still with **no** `-allowProvisioningUpdates`. `signing.ts` keeps its role: prove the assets exist and provision the device *before* a 3-minute build, and record them in the manifest |
| `iproxy` tunnel is how a device is reached | usbmux cannot see a Wi-Fi-paired phone at all (`idevice_id -l` empty), but `xcodebuild` launches the runner over CoreDevice anyway and WDA announces its own address (`ServerURLHere->http://…:8100<-`) | The announced address is parsed from the runner log and used directly. The tunnel is now a *preference* for genuinely cabled devices. The runner log is truncated per launch so a stale address cannot read as success |
| `read_syslog` on device via `log collect --device-udid` | Needs root: "Must be root to collect logs from attached device" | Crash reports always (CoreDevice `systemCrashLogs`, unprivileged, over the network); log lines via `idevicesyslog` only when cabled, captured **live** for seconds. Both halves reported explicitly (decision taken with the operator) |
| `visual_diff` / `record_screen` as designed | Unchanged | Verified on the simulator: 9 s recording → playable h264 1206×2622; `visual_diff` locates a known change and keeps antialiasing noise at 0 % |
| Port tree-driven `full_page_screenshot` to android-mcp | Already shipped there | Dropped from scope |

### Verified so far

- **Device (iPhone 12, iOS 27.0, Wi-Fi):** signed WDA build, runner launch, WDA
  ready in ~10 s, `/status`, `/wda/activeAppInfo`, `/source` (34 KB in 1.3 s),
  `/wda/screen` scale 3 — `scripts/verify-device.ts` PASS.
- **Simulator (iPhone 17 Pro, iOS 26.5):** `verify-phase0.ts` and
  `verify-integration.ts` PASS on the unified WDA capture path; recording and
  `visual_diff` exercised end to end.
- **Unit:** 56 tests — uitree condensing, devicectl JSON shape, profile
  matching, `visual_diff` geometry.

### Still unverified (needs the phone reachable)

`devicectl device info files` / `info processes` field names (crash listing and
terminate-by-bundle-id), device `reset_app` (uninstall → install → launch), and
device `record_screen` over WDA's MJPEG stream. Each is isolated in
`devicectl.ts` / `recorder.ts`; the JSON field names are the likely breakage.
