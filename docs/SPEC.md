# ios-mcp — Design Spec

**Date:** 2026-08-17
**Status:** Approved for implementation (v1)
**Reference implementation:** `~/codes/mcp-servers/android-mcp` (Playwright-style Android MCP server)

---

## Goal

An MCP server (`mcp__ios__*`) that drives iOS **simulator** apps the way android-mcp drives Android devices: semantic, element-aware automation over the accessibility tree, with the same 14-tool surface so agent instructions written for android-mcp transfer 1:1.

## Who it's for

AI agents (Claude Code sessions and sub-agents) testing Habuild's React Native apps on iOS simulators — the iOS half of the existing android-mcp workflow. Humans never call these tools directly.

## Decisions (locked with user, 2026-08-17)

| Decision | Choice |
|---|---|
| Device scope | **Simulator-only v1**; real devices deferred to v2 |
| Backend | **Direct WebDriverAgent (WDA) over HTTP** — no Appium server, no idb |
| Runtime | **Bun + TypeScript**, same deps as android-mcp (`@modelcontextprotocol/sdk`, `zod`, `sharp`) |
| Tool surface | **Full 14-tool mirror** of android-mcp in v1 |
| WDA lifecycle | **Auto-managed by the server** (build cached once; launch/health-check/reuse per tool call) |

Backends considered and rejected:
- **idb** (already installed on this machine): zero-setup a11y tree + gestures on simulators, but effectively unmaintained by Meta and a dead end for real devices — choosing it would force a backend rewrite in v2.
- **Full Appium server**: an extra long-lived Node server, session management, and a large dependency tree for capabilities v1 doesn't use. YAGNI.
- **Direct WDA** wins: actively maintained (Appium team ships it), plain HTTP (`fetch`, no client library), and v2 real-device support is a signing change, not a rewrite.

## Architecture

```
MCP client (Claude Code)
   │ stdio
   ▼
ios-mcp (Bun + TS)
   ├── simctl.ts   — device discovery/boot/launch/log/reset  → shells out to `xcrun simctl`
   ├── wda.ts      — WDA lifecycle + HTTP client              → xcodebuild (launch) + fetch (drive)
   ├── uitree.ts   — /source JSON → condensed grouped elements (port of android uitree.ts)
   ├── actions.ts  — tap / type / wait / scroll (resolve via tree, act via WDA)
   ├── screenshot.ts — viewport + full-page frames (sharp for pixel fallback)
   ├── device.ts   — current_app, read_syslog, reset_app
   └── index.ts    — MCP server, tool registration
   │
   ▼
WebDriverAgentRunner (XCUITest) on the target simulator, one instance per UDID,
HTTP on a per-UDID port (base 8100). Prebuilt once by setup; launched on demand.
```

**Core principle carried over from android-mcp:** a tool exists only if it *composes, loops, condenses, or works semantically* on the UI tree. No 1:1 `simctl` wrappers (install, uninstall, openurl, keyevent-style things) — run those with `xcrun simctl` directly.

**Locator strategy carried over:** dump the whole tree (`GET /source?format=json`), match the selector **server-side** (exact-over-substring, cleaned labels), then act on the element's **center coordinates** via W3C actions. We deliberately do *not* use WDA's element-find/element-id API — coordinate acting on a fresh tree avoids stale-element errors and keeps the matching logic identical to android-mcp's.

### WDA lifecycle (auto-managed)

1. **One-time setup** (`bun run setup`): fetch WDA source (the `appium-webdriveragent` npm package ships it), then
   `xcodebuild build-for-testing -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination 'generic/platform=iOS Simulator'`.
   Cache the products + `.xctestrun` under `~/.cache/ios-mcp/wda/<xcode-version>/`. **No code signing needed for simulators.**
2. **Per tool call**: `ensureWda(udid)` —
   - boot the simulator if shut down (`simctl boot` + `simctl bootstatus -b`);
   - `GET http://localhost:<port>/status`; if healthy, reuse;
   - else spawn `xcodebuild test-without-building -xctestrun <cached> -destination "id=<udid>"` with `USE_PORT=<port>`, poll `/status` until ready (timeout 60 s), keep the child process handle;
   - create/reuse a WDA session (`POST /session` with empty capabilities = attach to whatever is foreground). On any `invalid session id` error, recreate the session once and retry the request.
3. **Staleness guard**: the cache records the Xcode build version (`xcodebuild -version`). On mismatch at runtime, fail with a one-line message telling the agent to re-run `bun run setup` (auto-rebuild is deliberately not silent — a 5-minute build should never hide inside a `tap` call).
4. **Ports**: one WDA per UDID, port = first free port from `IOS_MCP_WDA_PORT_BASE` (default 8100). Registry keyed by UDID.
5. **Teardown**: WDA children are killed on server exit (`SIGTERM` handler); orphan detection on startup kills any `xcodebuild … WebDriverAgentRunner` process whose port answers but whose UDID no longer has a booted sim.

Cold-start budget: ~10–20 s on the first tool call of a session (sim boot + WDA launch), then instant.

### Coordinate system: points vs pixels

iOS splits what Android unifies: WDA's tree rects and W3C actions are in **points**; screenshots are in **pixels** (`points × scale`, scale 2–3). To preserve the android-mcp agent contract ("a pixel you read off the screenshot taps true"):

- `screenshot` returns the image path **plus `{width, height, scale}`** of the actual PNG.
- `tap_xy` accepts **screenshot-pixel coordinates** and divides by the device scale internally before issuing the W3C action.
- All tree-derived tap points stay internal (points) — agents never see or convert them.

## Tool surface (14 tools, mirroring `mcp__android__*`)

Selector object everywhere it appears: `{ text?, id?, type? }` — `text` matches label/name/value (contains, exact-match wins over substring, TalkBack-style noise cleaning ported as-is), `id` matches accessibility identifier, `type` matches role. Same semantics as android-mcp's `{text|id|desc}` with `desc → id` being the only rename (iOS has no separate content-description; accessibility identifier is the developer-set handle, which for React Native is `testID`).

### Device management

| Tool | Params | Behavior |
|---|---|---|
| `list_devices` | — | `simctl list devices --json`, filtered to available. Returns name, UDID, iOS version, state (Booted/Shutdown), and which one is currently targeted. |
| `select_device` | `udid` (or unique name substring) | Sets target. Boots it if shut down. Default target without a call: the single booted sim, else error listing candidates. `IOS_MCP_UDID` env pre-selects. |

### Capture & inspection

| Tool | Params | Behavior |
|---|---|---|
| `inspect_screen` | — | Condensed, grouped element list from WDA `/source?format=json`: geometric-containment grouping (labels fold into smallest interactive ancestor), redundant wrappers dropped, `role` mapped from `XCUIElementType*` (`Button/Cell/Link → button`, `TextField/SecureTextField/TextView/SearchField → input`, `StaticText → text`, `Image → image`), invisible elements (`isVisible: false`) excluded. Reports `sparse: true` when <3 actionable elements (canvas/games) → agent falls back to `screenshot` + `tap_xy`. Labels clipped to 80 chars for output; matching uses full text. Reports `ungroupedCount`. |
| `find_element` | selector | Present? Returns matched label, role, bounds (in screenshot pixels), visibility. |
| `screenshot` | — | `simctl io <udid> screenshot` → PNG on disk; returns **path** (never inline base64) + `{width, height, scale, orientation}`. |
| `full_page_screenshot` | `maxFrames?` (default 10) | Scroll-to-bottom, return **ordered list of overlapping viewport frame paths** — no stitching (android-mcp learned this the hard way; the reasons — sticky bars, floating buttons, autoplaying media — apply identically on iOS). Bottom detection is **tree-based** (stop when a scroll adds no new element labels; `bottomDetectedBy: "tree"`), pixel-diff fallback via sharp on sparse screens (`"pixel"`). |

### Element-aware interactions

| Tool | Params | Behavior |
|---|---|---|
| `tap` | selector | Dump tree → match → W3C action tap at element center (points). Error lists nearest labels when no match. |
| `tap_xy` | `x, y` (screenshot pixels) | Escape hatch for `sparse` screens. Converts pixels→points via scale. |
| `type_into` | selector, `text`, `clearFirst?` | Tap the input to focus, wait for keyboard, then `POST /wda/keys`. `clearFirst` selects-all + deletes (send `` backspaces sized to current value length). Errors clearly if the field is a secure field rejecting programmatic input. |
| `wait_for` | selector, `timeoutMs?` (default 10 000) | Poll tree until match. Returns element + elapsed. |
| `scroll_until` | selector, `maxScrolls?` (default 10) | Swipe up (content scrolls down) re-checking tree each step; stops at match or bottom (same tree-based bottom check). |

### Device & test utilities

| Tool | Params | Behavior |
|---|---|---|
| `current_app` | — | **iOS deviation from `current_activity`** (no Activity concept). Returns foreground `bundleId` + `pid` (WDA `/wda/activeAppInfo`) **plus the same `screenSignature`** (hash of the tree's accessibility identifiers/types — required because RN/SwiftUI apps are single-window, exactly like the single-Activity problem on Android) and best-guess `screenTitle` (navigation-bar title, else topmost prominent StaticText). Same-bundle + changed-signature across calls ⇒ navigation happened. |
| `read_syslog` | `bundleId?`, `filter?`, `sinceSeconds?` (default 120), `lines?` (default 200) | **iOS deviation from `read_logcat`.** `simctl spawn <udid> log show --last <s>s --style compact` with an NSPredicate (`processImagePath CONTAINS`) built from the bundle id's executable name. Auto-flags crashes: scans `~/Library/Logs/DiagnosticReports/*.ips` newer than the window for the process and surfaces the crash reason + report path. RN redbox/JS errors surface via the normal log lines. |
| `reset_app` | `bundleId`, `reinstall?` + `appPath?` | Fresh first-run state: terminate → wipe the app's data container contents (`simctl get_app_container <udid> <bundleId> data` → empty `Documents`, `Library`, `tmp`) → relaunch via `simctl launch`. With `reinstall: true` (requires `appPath`): uninstall → install → launch instead — needed when first-run state lives in Keychain or app-group containers that a data-container wipe misses. |

### Deviation summary vs android-mcp

- `current_activity` → **`current_app`** (bundle id + pid; `screenSignature`/`screenTitle` preserved).
- `read_logcat` → **`read_syslog`** (unified log + `.ips` crash reports instead of logcat + ANR).
- Selector key `desc` → **`id`** (accessibility identifier ≙ RN `testID`).
- `tap_xy`/bounds are in **screenshot pixels** with internal point conversion (Android's are natively unified).
- Everything else is name-, param-, and behavior-identical.

## Device management model

- Target = one simulator UDID held in server state; `select_device` switches it; `IOS_MCP_UDID` pre-selects; single-booted-sim auto-selected.
- Selecting a shut-down sim boots it and waits for `bootstatus`.
- WDA instances are per-UDID and coexist (distinct ports), so switching targets doesn't kill the previous WDA.

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `IOS_MCP_UDID` | Default target simulator | auto (single booted sim) |
| `IOS_MCP_OUTPUT_DIR` | Screenshot output dir | `$TMPDIR/ios-mcp` |
| `IOS_MCP_WDA_PORT_BASE` | First WDA port | `8100` |
| `IOS_MCP_WDA_HOME` | WDA build cache | `~/.cache/ios-mcp/wda` |

## Setup / prerequisites

1. macOS with **Xcode** (26.x verified on this machine) + at least one iOS simulator runtime.
2. `bun install` in the repo.
3. **`bun run setup`** — one-time WDA fetch + `build-for-testing` (re-run after Xcode upgrades; the server detects version mismatch and says so). ~3–5 min.
4. Register: `claude mcp add ios -- bun run ~/codes/mcp-servers/ios-mcp/src/index.ts`.

No Apple ID, no signing, no provisioning profile, and **nothing that touches Apple's cloud** — simulator XCUITest builds are fully local (compliant with the user's restricted-Apple-cloud-push policy).

## Known risks & mitigations

| Risk | Mitigation |
|---|---|
| **WDA `/source` slow on huge trees** (deep SwiftUI/RN hierarchies can take seconds) | Set WDA session settings `snapshotMaxDepth` (start at 50) and `customSnapshotTimeout`; measure on Habuild's app in Phase 1 and tune. Tree dumps are the hot path — budget one dump per tool call, never more. |
| **WDA flakiness** (session dies, runner crashes mid-run) | `ensureWda` health-check on every call; one automatic session-recreate + retry; runner relaunch on connection refused. Errors that survive the retry return a diagnosable message (WDA log tail path included). |
| **Xcode upgrade breaks cached WDA build** | Cache keyed by Xcode build version; explicit "re-run setup" error, never a silent multi-minute rebuild inside a tool call. |
| **Simulator "Connect Hardware Keyboard" swallows the on-screen keyboard**, breaking `type_into` | Setup disables it (`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`); `type_into` also detects a missing keyboard after focus-tap and reports it explicitly. |
| **Secure text fields / system permission alerts** | Same boundary policy as android-mcp's biometric rule: system dialogs are tappable (they appear in the tree via the Springboard session scope), but the server never tries to bypass what the tree can't reach. Documented, not worked around. |
| **Points-vs-pixels confusion** | Solved structurally (see coordinate section): agents only ever see screenshot pixels. |
| **Unified log volume** | Always predicate-filtered + time-bounded; hard cap on returned lines. |
| **v2 real devices** | The WDA HTTP surface is identical on device; deferred work is signing (local, allowed), `devicectl`-based install/launch replacing `simctl`, and port forwarding. No architectural change. |

## Phased build plan

**Phase 0 — plumbing (the risk burn-down).** Repo scaffold mirroring android-mcp's layout; `setup.ts` (WDA fetch + build + cache); `wda.ts` (launch, health, session ensure, port registry, teardown); `simctl.ts` (list/boot/launch). Exit criterion: `GET /status` green on a cold-booted sim, driven end-to-end by one script.

**Phase 1 — see.** `list_devices`, `select_device`, `screenshot`, `uitree.ts` port (grouping/roles/label-cleaning against real WDA `/source` output), `inspect_screen`, `find_element`. Exit: `inspect_screen` on a Habuild RN app returns a clean grouped list with `testID`s visible as `id`.

**Phase 2 — act.** `tap`, `tap_xy` (pixel→point), `type_into`, `wait_for`, `scroll_until`. Exit: scripted login-ish flow (launch → wait_for → type_into → tap → wait_for) passes on the RN app.

**Phase 3 — test utilities.** `full_page_screenshot` (frames + tree bottom detection), `current_app` (signature/title), `read_syslog` (+ crash flagging), `reset_app`. Exit: full 14-tool parity checklist against the android-mcp README.

**Phase 4 — harden & document.** Error-message quality pass (every failure names its cause and next step), orphan/teardown edge cases, README in android-mcp's style, `learnings/` folder seeded with WDA gotchas discovered en route, test report doc (mirror `docs/test-report-*.md`), register with Claude Code, update the global CLAUDE.md device-testing section to mention `mcp__ios__*`.

## Success criteria

- An agent with zero manual steps (beyond one-time `bun run setup`) can: boot a sim, launch a Habuild RN app, `inspect_screen`, `tap` by `testID`, `type_into` a field, `wait_for` the next screen, and read a crash out of `read_syslog` — all through `mcp__ios__*` tools.
- Agent instructions written for android-mcp work against ios-mcp with only the two documented renames (`current_activity → current_app`, `read_logcat → read_syslog`).
- First tool call of a session completes in ≤ 30 s cold, subsequent calls in ≤ 3 s (tree dump included).

## Explicitly out of scope (v1)

- Real devices (v2: signing + `devicectl` + port forward — no rewrite).
- Stitched full-page screenshots (rejected permanently, same rationale as android-mcp).
- 1:1 `simctl` wrappers (install/uninstall/openurl/push-notification simulation) — use `xcrun simctl` directly.
- visual_diff / perf snapshots / screen recording (android-mcp v2 roadmap items; keep parity later).
