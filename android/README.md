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

## The bridge (version 1)

Page to app: `info()`, `start(optionsJson)`, `stop()`, `setCross(x, y)`, `depthGrid(nx, ny, kind, minConf)`,
`grab()`, `openExternal(url)`, `log(msg)`. App to page: `LawnARNative_onFrame(frame)` about 30 times a second
(pose, view, projection, the crosshair's hit, Geospatial when on) and `LawnARNative_onEvent(event)` (started,
installing, error, end).

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
