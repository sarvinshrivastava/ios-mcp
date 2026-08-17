# WDA /source tree — what real dumps actually look like

Validated against real dumps of an RN app (com.habuild.yatraready) and
springboard system alerts on iOS 26.5. The uitree condenser's fixture
assumptions were diffed against these.

## `name` defaults to `label`
- When an element has no accessibilityIdentifier, WDA fills `name` with the
  label — so `id` in inspect_screen output can be visible text, not a testID.
  Real testIDs DO come through (RN redbox buttons show `redbox-dismiss`,
  `redbox-reload`, `redbox-copy`, `redbox-extra`).
- Consequence: `id`-suffix matching can false-positive on label text. Prefer
  `text:` selectors unless you know the testID.

## Twin nodes are real
- WDA snapshots can contain literal duplicate nodes — same type, same label,
  same rect — for one visual element (seen on springboard alert scroll bars).
  The condenser dedupes on (type, label, id, bounds).

## Scroll-indicator decorations pollute the tree
- UIScrollView's indicators surface as named Others: "Vertical scroll bar,
  1 page" / "Horizontal scroll bar, …". They'd classify as interactive
  (Other-with-name heuristic) — filtered by label pattern instead.

## System alerts live in springboard
- While an alert covers the app, `current_app` reports
  `com.apple.springboard` and the tree shows the alert's elements — which
  makes the alert fully tappable via the normal `tap` tool ("Not Now" etc.).
  This is correct behavior, not a bug: dismiss the alert, then the app's own
  tree comes back.

## RN redbox is fully drivable
- The redbox error screen exposes its message as element labels and its
  buttons with real testIDs — an agent can READ the crash message via
  inspect_screen and tap "Dismiss (ESC)" / "Reload (⌘R)" without pixels.

## isVisible / isEnabled
- Come back as "1"/"0" strings in some WDA versions, booleans in others —
  coerce both. If a dump shows EVERYTHING invisible, that's a WDA snapshot
  settings problem (`snapshotMaxDepth`/compact responses), not app behavior.
