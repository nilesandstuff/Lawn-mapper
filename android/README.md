# Yard AR, the Android app

A thin native shell (core session, 2026-11-07; docs/SCAN-PLAN.md section 10). ARCore and the camera are native; the
page the user sees and uses is the scan site's own (`scan/public`), loaded in a transparent WebView over the camera.
The page talks to ARCore through one bridge, `window.LawnARNative` (`Bridge.kt`), as tracking engine `native`
(`scan/lib/track.js startNative`).

## Why it is built this way

- A change to what the app *does* (what to record, when, how to place a walk, the HUD, nudges, a future AR viewer
  drawn in the page's WebGL) is a scan site deploy, live the next time the app opens the page. No new APK.
- A new APK is needed only when the bridge needs something new. `BRIDGE` in `app/build.gradle.kts` counts its
  versions; the page's `BRIDGE_NEEDED` (`scan/public/app.js`) says which it needs and offers the update when the
  installed app is older. The page also offers it whenever a newer build is published.
- What the app does with the camera is tuned from the page (`NATIVE_OPTIONS`, `NATIVE_DEPTH` in track.js): picture
  size and rate, depth kind and confidence, Geospatial rate.

## The bridge (version 4)

Page to app: `info()`, `start(optionsJson)`, `stop()`, `setCross(x, y)`, `depthGrid(nx, ny, kind, minConf)`,
`grab()`, `openExternal(url)`, `log(msg)`; since version 2 `anchor(x, y, z)` (an ARCore anchor's id, or -1) and
`dropAnchor(id)`. App to page: `LawnARNative_onFrame(frame)` about 30 times a second (pose, view, projection, the
crosshair's hit, Geospatial when on; since version 2 `sem`, the share of the picture under each Scene Semantics label,
and `anchors`, [[id, x, y, z, state], ...]) and `LawnARNative_onEvent(event)` (started, with `semantics` since
version 2; installing, error, end). Since version 2 `depthGrid` also carries each cell's semantic label `l` (ARCore's
numbers 0-11) and its confidence `lc`.

Version 3 (app 1.9, 2026-11-08): RECORDING AND REPLAY. `start` takes `record: <walk id>` (ARCore Recording & Playback
writes the walk's camera, motion and Geospatial input to recordings/<walk>.mp4, with the page's actions on a data
track: `record(json)`) and `playback: <walk id>` (the walk's recording fetched from the site, then ARCore runs on it
instead of the camera; the page's recorded actions come back in the frame's `events`, and a `playbackEnd` event when
it is over). After a walk the MP4 goes to the scan site in 8 MB pieces with the page's sign-in cookie
(scan/src/recording.js) and is deleted from the phone once the site has it; what could not be sent is sent when the
app next opens (`pendingRecordings()`, `sendRecordings()`). Events: fetching, download, upload, recorded,
playbackEnd. Also Geospatial Depth (Streetscape Geometry on with Geospatial and depth: ARCore's smoothed depth to 65 m
where Google has VPS; `depthGrid(..., 'smooth', ...)` keeps it beside the raw), and `started` lists every camera mode
ARCore offers (camera id, picture and texture sizes, frame rates, depth sensor, stereo).

Version 4 (2026-11-08): recordings kept on the phone. `localRecordings()` ([{ walk, bytes, sent }]),
`removeRecording(walk)`, `keepRecordings()` / `setKeepRecordings(on)` (default on: a recording stays once the site has
it, marked sent, and one fetched for a replay is kept too; a replay uses the phone's copy when there is one). With keep
off, a sent recording leaves the phone, and a fetched one leaves when its replay ends. The app takes the smallest
camera mode (640x480) unless `start` asks `cameraImage: 'largest'` (1.10: the largest made 2.2 GB recordings).
App 1.12 (bridge unchanged): the sending runs in a foreground service (UploadService.kt, data-sync kind) with
its progress in a notification, so it carries on with the screen off or the app in the background.

What Chrome's WebXR does not give and this does: raw depth with ARCore's confidence (Chrome on the S21 ignores the
raw request, SCAN-PLAN), the camera's own picture at the camera mode's full size, ARCore's Geospatial pose (with a
key), and room for ARCore's session recording.

## Building, signing, installing

Workflow "A. Android app" builds on GitHub, signs with a key it made once and keeps in the scan site's private
bucket (`app/release.jks`, never served), and publishes the APK and `version.json` there. The site serves them to
the admin at `/api/app/apk` and `/api/app/version` (`scan/src/app.js`).

On the phone: the scan site in Chrome (signed in) shows "Get the app" (download, allow installing from Chrome once)
and "Open in the app", which pairs the app's WebView with the Chrome sign-in through a one-time code
(`/api/app/pair`, then `lawnar://signin?t=...`, then `/api/app/claim`; five minutes, once).

Optional: a repository secret `ARCORE_API_KEY` (a Google Cloud API key with the ARCore API on) turns on the
Geospatial API at the next build.

Local build (the session's own check): Android SDK 35, Gradle 8.14, JDK 17+:
`gradle -p android assembleRelease -PscanUrl=https://scan.example.com`.
