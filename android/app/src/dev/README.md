# DEV ONLY: the USB thermal camera

Everything in this folder is compiled into the **dev** build of the Yard AR app and into nothing else. A build for
the Play Store is the **store** flavour, which compiles `src/store/` in its place (an empty `Extras.kt`).

The owner, 2026-11-15: "thermal will not be packaged in the public release app that we eventually release some
day. So keep the code neatly marked so that it's not accidentally copied over to the production version."

So the rules:

- Nothing under `src/main/` imports from here. `MainActivity` and `ArEngine` call the four functions of `Extras`
  (install, intent, arFrame, destroy) and know nothing else. Workflow "A. Android app" refuses to build if `src/main`
  or `src/store` names the thermal code, and compiles the store flavour on every run to prove it stands without it.
- On the page, the whole of it is `scan/public/thermal.js`, loaded only when the app offers `window.LawnARThermal`;
  app.js only announces a walk's start and end (a `yard-walk` event).
- On the scan site, `&file=thermal` on the recording routes (`scan/src/recording.js`), admin only.
- No vendor, app or model names in these files. Nothing derived from the vendor's software is here: the conversion
  from raw counts to temperature and the calibration live in the owner's private repository. The camera's
  calibration tables carry its serial number: they stay in the app's private storage (`files/thermal/tables/`) and
  are never logged or put in this repository.

## Where each part came from

`java/app/lawnmapper/thermalprobe/Uvc.kt` is the thermal session's own file, copied unchanged from its branch
(`thermal-probe/`, commit 183e2f7). A fix to it is made there and copied again, not made here.

`ThermalCamera.kt` ports the probe's connect sequence, range setup, dark-level loop and shutter reference step for
step. What is kept, how often, and the checks (crop, 2 frames a second, references every 30 s then 45 s, the sky
shot within 20 degrees of straight up) are the thermal session's answers of 2026-11-15. Nothing was guessed; a
question about the camera goes to the thermal session.

## What a walk leaves: twins/<walk>/thermal.bin

Written on the phone by `ThermalFile.kt`, sent by `ThermalUpload.kt` in 8 MB pieces (resumable; taken off the phone
once the site has it). Little-endian throughout.

    "LMTH"  u8 version (1)
    then records:  u8 kind   u32 length   payload

    'J'  JSON (UTF-8), field k:
           start   format, walk, wall_ms, elapsed_ns, width, rows, camera_width, camera_rows, keep_every, crop [first row, last row, first col, last col],
                   base, tables (sha256 of each calibration table by type: a fingerprint, never the table),
                   setup (vendor | own), state, words (row 216's first 24 words), app (the app's version), phone, android
           setup   the camera became ready (again, after an unplug): tables, setup, words, elapsed_ns
           range   the range setup's outcome and its log (when the app set the range itself)
           ref     a shutter reference: index, t0_ns, t1_ns, frames, dark_level, log, words
           sky     a sky shot: label (start | end), t0_ns, t1_ns, up_deg_start, up_deg_end
           sweep   a timing sweep: t0_ns, t1_ns
           unplug  elapsed_ns
           end     elapsed_ns, frames, dropped
    'F'  a frame: a 38-byte head, then the bytes
           u8   type      0 scene, 1 shutter reference (the 16), 2 sky, 3 sweep, 4 shutter closed or moving
           u8   packing   1 deflate; 2 minus the base frame (each u16, modulo 65536), then deflate
           u16  width (260)    u16 rows (217)
           u32  sequence (every camera frame counts, kept or not)
           u32  reference index (the latest reference begun; 0 before the first)
           u32  base frame's sequence (0 when packing is 1)
           i64  elapsedRealtimeNanos when the frame was whole
           i64  UVC pts
           u16  payloads   u16 errors
         bytes (after inflating, and adding the base frame back for packing 2): the camera's raw u16, rows 0-216
         and columns 0-259, row after row. The base is always the first frame of a reference (type 1, packing 1)
         earlier in the same file.
    'P'  ARCore's camera pose at one ARCore frame (45 bytes)
           i64  Frame.getTimestamp() (ns)      i64  elapsedRealtimeNanos read beside it
           f32 x y z        Camera.getPose() translation: the physical camera, ARCore's world (metres, y up)
           f32 qx qy qz qw  its rotation
           u8   tracking (1 = ARCore was tracking)

Kept: about 2 frames a second while walking (every 12th), and every frame for a reference's 16, a sky shot (2 s) and
a sweep (5 s). A file cut short (the app closed mid-walk) ends in a partial record; everything before it is whole.

How ARCore's world becomes the map's east/north/up metres is not in this file: it is in the walk's twin
(`twins/<walk>/live.json`), written by the page. docs/SCAN-PLAN.md section 27.
