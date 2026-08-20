# Running WebDriverAgent on a real iPhone (Xcode 26.6, iOS 27)

Measured while building v2 real-device support. Everything here is local-only —
no Apple Developer portal calls.

## Signing

- **Manual signing fails with Xcode-managed profiles.** `CODE_SIGN_STYLE=Manual`
  + `PROVISIONING_PROFILE_SPECIFIER=<uuid>` errors with
  `Provisioning profile "iOS Team Provisioning Profile: *" is Xcode managed, but
  signing settings require a manually managed profile`.
- **Naming a profile also breaks the framework target:**
  `WebDriverAgentLib does not support provisioning profiles, but provisioning
  profile … has been manually specified`. Frameworks never take profiles.
- **What works:** automatic style pinned to a team, nothing else —
  `CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team>`. Xcode then picks the
  matching local profile itself. Verified: `** TEST BUILD SUCCEEDED **`.
- **Never pass `-allowProvisioningUpdates`.** It registers devices and mints
  profiles server-side. Without it, xcodebuild may only use assets already on
  the Mac — which is exactly the constraint we want.
- Useful invariant: a wildcard team profile (`TEAM.*`) covers WDA's runner
  bundle id (`com.facebook.WebDriverAgentRunner.xctrunner`) with no per-app
  setup, and Xcode-managed wildcard profiles already list every device the Mac
  has ever developed against.

## Reading a .mobileprovision from a script

- `security cms -D -i <file>` decodes it to a plist, but
  **`plutil -convert json` on the whole thing fails** —
  `Invalid object in plist for JSON format`. JSON has no date type and every
  profile carries `CreationDate`/`ExpirationDate` (two more keys hold raw DER).
- Removing the binary keys is not enough; the dates still break it.
- Working approach: pipe the decoded plist to
  `plutil -extract <key> raw|json -o - -` once per key you need. `raw` prints
  ISO-8601 for dates. A missing key just exits nonzero.

## Reachability — no cable required

- **usbmuxd does not see a Wi-Fi-paired device.** `idevice_id -l` and
  `idevice_id -n` are both empty while `devicectl` talks to the phone fine, so
  `iproxy` cannot forward anything. `transportType: "localNetwork"` in
  `devicectl list devices` is the tell.
- **`xcodebuild test-without-building -destination id=<udid>` still launches the
  runner** over CoreDevice's network link, and WDA prints where it bound:
  `ServerURLHere->http://172.16.0.222:8100<-ServerURLHere` — the phone's own LAN
  address. Hitting that address directly works; no tunnel involved.
- So: parse the announced URL from the runner log, and treat an iproxy tunnel as
  a preference for when the device really is on USB, not a requirement.
- **Truncate the runner log before every launch.** A stale `ServerURLHere` line
  from a previous run reads as success and sends every request to a dead
  address.
- **`localhost:<port>` health checks are ambiguous across targets.** A device
  instance whose address is not yet known must not be health-checked at all — a
  simulator's WDA on the same port will answer `ready: true` and you silently
  drive the wrong device.

## devicectl notes

- Its own help states a `--json-output <path>` file is the **only** supported
  machine-readable interface; the human table is not. Parse the file.
- `devicectl` writes JSON even on failure — read the payload's error before
  trusting the exit code alone.
- A device has **two** identifiers: the hardware `udid`
  (`00008101-0011685C1422001E`) used by iproxy / `log` / provisioning profiles,
  and devicectl's own `identifier` UUID which is what `-d` wants. They are not
  interchangeable.
- `tunnelState: "unavailable"` is CoreDevice's way of saying unreachable;
  `pairingState: "paired"` says nothing about reachability.
- `xctrace list devices` lists a network-paired device under **Devices Offline**
  — misleading. `devicectl list devices` is the truth.
- `devicectl device info apps` gives bundle id + the app URL, whose last path
  component is the executable name that the unified log uses — the device
  equivalent of `simctl appinfo … CFBundleExecutable`.
- There is **no** `devicectl` console/log subcommand and no delete verb under
  `copy` (only `to`/`from`), which is why device log reading needs
  `log collect --device-udid` and `reset_app` on a device must reinstall.

## Timings (iPhone 12, iOS 27.0, over Wi-Fi)

| Step | Cost |
|---|---|
| Signed `build-for-testing` (one-time, per Xcode version) | ~2–4 min |
| WDA cold start (runner launch → `/status` ready) | ~10 s |
| `/source` full tree dump (Settings app) | ~1.3 s, 34 KB |

## Device logs and resets: what Apple does NOT allow

- **`log collect --device-udid <udid>` needs root**: `log: Must be root to
  collect logs from attached device`. So there is no unprivileged way to read a
  device's PAST unified log. (Note `log` must be called as `/usr/bin/log` from
  zsh scripts — a bare `log` hits the shell's own parsing and errors with
  "too many arguments".)
- `devicectl` has **no** console/log subcommand at all (Xcode 26.6). The only
  streaming options are `devicectl device process launch --console`, which
  RELAUNCHES the app and captures only from launch onward, and `idevicesyslog`,
  which rides usbmux and therefore needs a cable.
- Consequence for a tool: on a device, crash reports are always available
  (CoreDevice's `systemCrashLogs` domain, over the network, no privileges) but
  log lines are USB-only and forward-looking. Say so in the response — an empty
  `lines: []` otherwise reads as "the app logged nothing".
- **`devicectl device copy` has `to`/`from` and no delete verb**, so an app's
  data container cannot be emptied in place. A real "reset to first run" on a
  device is uninstall + install; anything else (terminate + relaunch) clears
  nothing and just over-promises.

## The device drops off

A network-paired phone goes `tunnelState: "unavailable"` the moment it sleeps or
leaves the Wi-Fi, and every devicectl call then fails with
`CoreDeviceService was unable to locate a device matching the requested device
identifier` (code 1011) — note the identifier in that message is an `ecid_…`
form, not the id you passed. Treat it as "reconnect the device", not as a bug.

## Recording and diffing

- Simulator recording is `simctl io <udid> recordVideo --codec h264` — must be
  stopped with **SIGINT**; SIGTERM/SIGKILL leaves an unplayable container.
  Same for ffmpeg.
- Device recording has no native encoder reachable from here: WDA's MJPEG
  server (device port 9100) piped into ffmpeg is the option, and it only serves
  frames while a WDA session is alive.
- For pixel comparison, greyscale raw bytes are enough to locate change and keep
  a full-screen diff cheap; a per-cell grid plus a connected-component merge
  turns "3.7% of pixels differ" into a couple of boxes worth acting on. A
  minimum changed-pixel count per cell is what stops antialiasing from lighting
  up the whole grid.
