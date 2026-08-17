# ios-mcp

**Playwright-style automation for iOS simulators, exposed as an MCP server.**

The iOS half of [android-mcp](../android-mcp): drives _any_ installed app on a
simulator — native or React Native, no instrumentation required — through
**WebDriverAgent over plain HTTP** (no Appium server). An AI agent gets the
same 14 high-level, element-aware tools as android-mcp, so instructions written
for one transfer to the other with two renames.

Simulator-only in v1 (by design). Real devices are a v2 signing change, not a
rewrite — the WDA HTTP surface is identical on hardware.

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
4. Register: `claude mcp add ios -- bun run ~/codes/mcp-servers/ios-mcp/src/index.ts`

First tool call of a session cold-starts the sim + WDA (~10–25 s); everything
after is instant. WDA runners are auto-launched per simulator (one port each,
base 8100), health-checked on every call, and killed on server exit.

## The 14 tools (`mcp__ios__*`)

Selector everywhere: `{ text?, id?, type? }` — `text` matches label/name/value
(exact beats substring), `id` is the accessibility identifier (**React Native
`testID`**), `type` is a role (`button`/`input`/`text`/…) or raw
`XCUIElementType` name.

| Tool | What it does |
| --- | --- |
| `list_devices` / `select_device` | Simulator discovery + targeting (auto-boots; single booted sim auto-targeted) |
| `inspect_screen` | Condensed accessibility tree — grouped rows, roles, tap points. `sparse:true` → canvas app, use vision |
| `find_element` | Is a selector on screen? Bounds + closest labels when missing |
| `screenshot` | Viewport PNG to disk (path, pixel dims, scale, orientation) |
| `full_page_screenshot` | Scroll-to-bottom **sequence of overlapping frames** — never stitched |
| `tap` / `tap_xy` | Semantic tap by selector / pixel escape hatch for sparse screens |
| `type_into` | Focus + type via the on-screen keyboard (`clearFirst` supported) |
| `wait_for` / `scroll_until` | Measure-and-act loops over the tree |
| `current_app` | Foreground bundleId + pid + `screenSignature` (navigation detector for single-window RN/SwiftUI apps) |
| `read_syslog` | App-scoped unified log + auto-flagged `.ips` crash reports |
| `reset_app` | Terminate → wipe data container → relaunch (or full reinstall) |

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
| `IOS_MCP_UDID` | Default target simulator | auto (single booted sim) |
| `IOS_MCP_OUTPUT_DIR` | Screenshot output dir | `$TMPDIR/ios-mcp` |
| `IOS_MCP_WDA_PORT_BASE` | First WDA port | `8100` |
| `IOS_MCP_WDA_HOME` | WDA build cache | `~/.cache/ios-mcp/wda` |

## Verification

- `bun test` — uitree condenser suite (fixtures include a real `/source` dump).
- `bun run scripts/verify-phase0.ts` — sim boot → WDA launch → session →
  `/source` → scale, end to end.
- `bun run scripts/verify-integration.ts [bundleId]` — full stack against a
  live app: inspect, tap, scroll, full-page frames, syslog.

Design docs: [`docs/SPEC.md`](docs/SPEC.md). Field notes: [`learnings/`](learnings/).
