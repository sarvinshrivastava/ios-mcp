# simctl + unified-log gotchas (Xcode 26 / macOS 26)

## simctl argument quirks
- `bootstatus -b <udid>` fails with "Invalid device: -b" — flag goes AFTER the
  udid: `simctl bootstatus <udid> -b`. Fast no-op when already booted.
- `simctl boot` races: "Unable to boot device in current state: Booted" —
  tolerate that exact error.
- `simctl launch` output is `"<bundleId>: <pid>"`; `terminate` on a not-running
  app exits 3 ("found nothing to terminate") — tolerate.
- `get_app_container <udid> <systemApp> data` prints `(null)` and EXITS 0 —
  string-check the output before any `rm`; a missing app exits 2 with stderr.
- `simctl appinfo` prints an old-style NeXTSTEP plist; `CFBundleExecutable` is
  regex-extractable directly (quoted when the name has spaces/dots).

## Unified log (read_syslog)
- `processImagePath CONTAINS "<exe>"` has FALSE POSITIVES — "Preferences"
  also matches `localizationswitcherd` (binary inside
  `IntlPreferences.framework`). Use `processImagePath ENDSWITH "/<exe>"`.
- `log show` prints a `Timestamp Ty Process[PID:TID]` header line (skip it) and
  harmless `getpwuid_r did not find a match for uid 501` noise on stderr.
- `log show --last <N>s` walks the whole window server-side — scale the
  subprocess timeout with the window size.

## Crash reports (.ips, macOS 26)
- Line 1 = compact JSON header (`app_name`, `name`, `timestamp`); the rest =
  pretty JSON body (`procName`, `exception{type,signal,message}`,
  `termination{namespace,indicator}`).
- Header timestamp is nonstandard: `"2026-08-17 10:54:02.00 +0530"` — strip the
  fraction and T-join before `Date.parse`.
- `procPath`/`coalitionName` embed the SIMULATOR UDID → filter crashes per-sim.
  Only exclude on a positive mismatch; absent fields stay included.

## Simulator keyboard
- "Connect Hardware Keyboard" swallows the on-screen keyboard and breaks
  typing: `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard
  -bool false` (setup does this; needs a sim restart to take effect).
