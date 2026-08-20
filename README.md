# ios-mcp

**Playwright-style automation for iOS simulators, exposed as an MCP server.**

The iOS half of [android-mcp](../android-mcp): drives _any_ installed app on a
**simulator or a real iPhone** — native or React Native, no instrumentation
required — through **WebDriverAgent over plain HTTP** (no Appium server). An AI
agent gets the same 14 high-level, element-aware tools as android-mcp (plus two
of its own), so instructions written for one transfer to the other with two
renames.

Real devices need no cable and no Apple Developer portal access: WDA is signed
with a certificate and profile already on the Mac, and Xcode launches the
runner over CoreDevice's network link.

---

## Why these tools (and not a wrapper per simctl command)

Same rule as android-mcp — a tool earns a place only if it does something a raw
one-liner can't:

| Criterion        | Example                                                     |
| ---------------- | ----------------------------------------------------------- |
| **Compose**      | `tap` = dump tree → match element → tap its center          |
| **Loop / state** | `full_page_screenshot`, `scroll_until`, `wait_for`          |
| **Condense**     | `inspect_screen` turns a deep RN tree into a short list     |
| **Semantic**     | `tap({text:"Login"})` instead of `tap(540, 1230)`           |

Pure 1:1 wrappers (`install`, `uninstall`, `openurl`, push simulation) are
deliberately absent — run those with `xcrun simctl` directly.

## Setup

1. macOS with Xcode (26.x verified) + at least one iOS simulator runtime.
2. `bun install`
3. `bun run setup` — one-time WebDriverAgent fetch + `build-for-testing`
   (~3–5 min, fully local, **zero code signing**). Re-run after Xcode upgrades
   (the server detects the mismatch and tells you).
4. **For real devices:** `bun run setup --device` (or `--all` for both). Signs
   WDA with an `Apple Development` identity and a development profile that
   already provisions the target device — pass `--udid <udid>` to require that.
   `-allowProvisioningUpdates` is never used, so nothing touches Apple's
   Developer portal; if no local profile fits, setup says exactly which piece
   is missing. Overrides: `IOS_MCP_TEAM_ID`, `IOS_MCP_PROFILE_UUID`,
   `IOS_MCP_SIGN_IDENTITY`.
5. Register: `claude mcp add ios -- bun run ~/codes/mcp-servers/ios-mcp/src/index.ts`

First tool call of a session cold-starts the target + WDA (~10–25 s); everything
after is instant. WDA runners are auto-launched per target (one local port each,
base 8100), health-checked on every call, and killed on server exit.

### Device prerequisites

Developer Mode on, screen unlocked, and either a data cable or the phone on
this Mac's network. `list_devices` shows a paired-but-unreachable phone as
`Unavailable`; `xctrace` calls a network-paired device "Offline", which is
misleading — `devicectl` is the source of truth and what this server uses.

## The 16 tools (`mcp__ios__*`)

Selector everywhere: `{ text?, id?, type? }` — `text` matches label/name/value
(exact beats substring), `id` is the accessibility identifier (**React Native
`testID`**), `type` is a role (`button`/`input`/`text`/…) or raw
`XCUIElementType` name.

| Tool | What it does |
| --- | --- |
| `list_devices` / `select_device` | Simulators **and** connected devices, one list. Auto-boots a simulator; auto-targets a single booted sim or a single connected device (one of each is ambiguous on purpose) |
| `inspect_screen` | Condensed accessibility tree — grouped rows, roles, tap points. `sparse:true` → canvas app, use vision |
| `find_element` | Is a selector on screen? Bounds + closest labels when missing |
| `screenshot` | Viewport PNG to disk via WDA on both backends (path, pixel dims, scale, orientation) |
| `full_page_screenshot` | Scroll-to-bottom **sequence of overlapping frames** — never stitched |
| `tap` / `tap_xy` | Semantic tap by selector / pixel escape hatch for sparse screens |
| `type_into` | Focus + type via the on-screen keyboard (`clearFirst` supported) |
| `wait_for` / `scroll_until` | Measure-and-act loops over the tree |
| `current_app` | Foreground bundleId + pid + `screenSignature` (navigation detector for single-window RN/SwiftUI apps) |
| `read_syslog` | App-scoped log + auto-flagged `.ips` crash reports. Simulator: a historical window. Device: crashes always, log lines only over USB (see below) |
| `reset_app` | Simulator: terminate → wipe data container → relaunch (or reinstall). Device: reinstall only, `appPath` required |
| `visual_diff` | Two screenshots → `diffPct`, verdict, changed regions as pixel boxes, annotated image. Omit `after` to capture now |
| `record_screen` | `action:"start"` … drive the app … `action:"stop"` → mp4. Auto-stops at `maxSeconds` |

### What a real device cannot do (and why it says so)

Both are Apple-side limits, not shortcuts — each is reported in the response
rather than silently degraded:

- **`read_syslog` lines need a cable.** `log collect --device-udid` exits with
  _"Must be root to collect logs from attached device"_, so the only
  unprivileged source is `idevicesyslog`, which rides usbmux and therefore
  needs USB. Crash reports come from CoreDevice's `systemCrashLogs` domain and
  work over the network either way. USB captures are also **live** for a few
  seconds — usbmux gives no history.
- **`reset_app` cannot wipe a container.** `devicectl device copy` has only
  `to`/`from`, no delete, so a real reset is uninstall + install and `appPath`
  is required.

### Deviations from android-mcp (the only ones)

- `current_activity` → **`current_app`** (iOS has no Activities; bundleId + the
  same `screenSignature` trick).
- `read_logcat` → **`read_syslog`** (unified log + `.ips` crash reports).
- Selector `desc` → **`id`** (accessibility identifier ≙ RN `testID`).

### Coordinates: you only ever see pixels

iOS splits points (WDA tree/actions) from pixels (screenshots, scale 2–3×).
The agent contract stays android-simple: every coordinate a tool RETURNS or
ACCEPTS is **screenshot pixels** — conversion happens server-side, always.

## Environment variables

| Var | Purpose | Default |
| --- | --- | --- |
| `IOS_MCP_UDID` | Default target (simulator or device) | auto (single ready target) |
| `IOS_MCP_OUTPUT_DIR` | Screenshot output dir | `$TMPDIR/ios-mcp` |
| `IOS_MCP_WDA_PORT_BASE` | First WDA port | `8100` |
| `IOS_MCP_WDA_HOME` | WDA build cache (`<xcode-build>/{sim,device}/`) | `~/.cache/ios-mcp/wda` |
| `IOS_MCP_TEAM_ID` / `IOS_MCP_PROFILE_UUID` / `IOS_MCP_SIGN_IDENTITY` | Pin device signing assets | auto-discovered |

## Verification

- `bun test` — uitree condenser, devicectl JSON shapes, profile matching, and
  `visual_diff` geometry (fixtures include a real `/source` dump and a real
  `devicectl list devices` payload).
- `bun run scripts/verify-phase0.ts` — sim boot → WDA launch → session →
  `/source` → scale, end to end.
- `bun run scripts/verify-integration.ts [bundleId]` — full stack against a
  live app: inspect, tap, scroll, full-page frames, syslog.
- `bun run scripts/verify-device.ts [udid]` — the real-device chain: reachable
  → unlocked → signed WDA provisions this device → runner launches → `/status`,
  `/source`, scale.

Design docs: [`docs/SPEC.md`](docs/SPEC.md) (v1),
[`docs/SPEC-v2.md`](docs/SPEC-v2.md) (real devices + the two new tools).
Field notes: [`learnings/`](learnings/).
