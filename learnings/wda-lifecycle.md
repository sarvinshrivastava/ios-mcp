# WebDriverAgent lifecycle gotchas (Xcode 26)

## USE_PORT env var does NOT reach the runner
- The Appium-documented trick (`USE_PORT=8123 xcodebuild test-without-building …`)
  silently does nothing on Xcode 26 — the env of the xcodebuild process never
  reaches the test process on the simulator; WDA binds 8100 regardless.
- Fix: copy the cached `.xctestrun` and bake the port in with
  `PlistBuddy -c 'Set :WebDriverAgentRunner:EnvironmentVariables:USE_PORT <port>'`.
- The copy MUST live in the same directory as the original — `__TESTROOT__`
  placeholders resolve relative to the xctestrun file's own directory.

## Bun.spawn'd xcodebuild deadlocks process exit
- A spawned long-lived `xcodebuild test-without-building` keeps Bun's event
  loop alive, so the `exit` handler that would kill it never fires — the server
  process hangs forever on shutdown.
- Fix: `child.unref()` right after spawn; SIGTERM/SIGINT/exit handlers still
  `child.kill()` fine.

## Simulator builds need zero signing
- `xcodebuild build-for-testing … -destination 'generic/platform=iOS Simulator'`
  with `CODE_SIGNING_ALLOWED=NO` — no Apple ID, no provisioning profile,
  nothing touches Apple's cloud. Real devices are the only thing that needs
  signing (v2).

## Cache invalidation
- Key the built products by the Xcode BUILD version (`xcodebuild -version`
  "Build version" line, e.g. `17F113`), not the marketing version. On mismatch,
  fail with "re-run `bun run setup`" — never silently rebuild inside a tool
  call (a 5-minute xcodebuild hiding inside `tap` is a debugging nightmare).

## WDA session facts
- `/status`, `/source`, `/wda/activeAppInfo` are SESSIONLESS — only
  actions/keys/`/wda/screen` need a session.
- `POST /session` with empty capabilities attaches to whatever is foreground.
- Set `appium/settings` `{snapshotMaxDepth: 50}` after session create — deep RN
  trees make `/source` crawl otherwise. Springboard dumps: 122–202 elements,
  sub-second.
- On `invalid session id`, recreate the session once and retry — WDA sessions
  die when the foreground app is relaunched.
