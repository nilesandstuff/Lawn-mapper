# Thermal probe

A test app (2026-11-13/14) that reads the owner's USB-C phone thermal camera directly, without the vendor's app,
so a thermal walk can be recorded during a Yard AR walk with ARCore's pose on every thermal frame. It now
produces the same temperatures as the vendor's own app from the camera's raw frames.

Everything derived from the vendor's software (the temperature conversion, the camera's calibration data and
tables, decompiled code, specifications) is in the owner's PRIVATE repository, not here. This file records what
the probe does and what was measured, in neutral terms.

## The camera on USB

- A plain UVC camera: one configuration, a Video Control interface (extension unit 10) and a Video Streaming
  interface with a BULK IN endpoint (0x81, 512-byte packets). One format: 264x222, 16 bits per pixel, 25 fps.
  Payload headers are 16 bytes (2 standard + 14 vendor bytes).
- The picture is rows 0-195 and columns 0-259 of each frame; the rest is reference rows and metadata. Row 216
  carries the sensor's own temperature (word 1, 14 bits x 0.02 C) and words that identify its mode.
- The frames are RAW detector counts: all correction is done on the phone.
- Commands use the vendor's protocol on extension unit 10 (wIndex 0x0A00): PROBE 0x85, GET 0x81, SET 0x01 on
  channels selected by wValue (0x0500 select, 0x0200 image, 0x0600 state, 0x1A00 file transfer, ...).

## What the probe does

On Connect (all automatic):
1. Binds to the camera and downloads its calibration tables (per-pixel gain, bad pixels, vignetting) over the
   vendor's file transfer. Reads only.
2. Puts the sensor into the vendor app's normal temperature range: 19 sensor registers with the camera's own
   factory adjustments, then a dark-level loop with the shutter closed (closed-shutter level held near 8192,
   stepping one bias register). Runtime settings only: unplugging resets them. If the camera arrives already
   set up by the vendor app (mode words 42/7/209), the registers are left alone.
3. Waits 30 s for the sensor to settle, then takes a shutter reference.

Capture 1 s: a fresh 16-frame shutter reference (the dark-level loop runs again first), 25 scene frames, and a
second reference right after. The shutter is moved through the camera's burn-prevention control (closed or
opened, then RELEASED: without the release the drive stays on and the blade warms, ~3.5 C in seconds).

Upload sends a zip of everything recorded to the private repository (a GitHub token entered once, kept in the
app's private storage). A runner there converts each capture to temperatures and, when photos from the vendor
app are added with "Add photo", compares them pixel for pixel. Recordings survive closing the app and are
cleared only after a successful upload. Workflow "T. Thermal probe" builds the APK
(thermal-probe-0.<run>.apk on the release thermal-probe-latest) when the app's code changes.

## Findings, in order

- Raw frames stream with no handshake. The shutter is latching and only moves on command.
- Once the shutter was under control, a flat-field (closed-shutter frames as the reference) gave clean pictures.
- The vendor's conversion from raw counts to temperature was rebuilt (private repository). The temperature
  step reproduces the vendor app's stored temperatures to 0.0001 C in 13 photos across two ranges; the per-frame
  base level is predicted from the sensor temperature (13/13 exact).
- The camera powers up in a sensor mode the vendor app never uses; the probe must set the range itself (step 2
  above). A mistaken register value once saturated the sensor; the setup now saves the power-on values and puts
  them back if the dark level does not settle.
- White dots that grew between captures were pixels clipping at 16383 in the reference as the camera warmed:
  fixed by the dark-level loop at every reference.
- Remaining offsets against the vendor app were the shutter warming while held (fixed by the release).

## Accuracy (run 15, the probe's own setup from power-on, static indoor scene)

The probe's temperatures minus the vendor app's, per pixel, photos taken just after the captures: +0.40 / +0.24 C
for the first capture, +0.16 / +0.00 C for the second; p5..p95 within +-0.1 C of each median; pictures aligned
to the pixel (correlation 0.992-0.994); the shutter reference moved 0.06-0.10 C across each capture.

## Alignment (0.31)

"Align shot" takes thermal frames and a phone-camera still at the same moment (main back camera, autofocus
off at the hyperfocal distance as ARCore keeps it, stabilisation and distortion correction off; the still's JSON
holds what the camera reports about its lens). Photographing a printed 9 x 7 checkerboard (25 mm squares) from
10-20 angles lets a runner in the private repository calibrate the thermal lens and the rotation and offset
between the two cameras (OpenCV).

## Next

Alignment of the thermal camera to the phone camera (field of view, distortion, and the offset between the two
lenses), then the integration into the Yard AR app's walk recording (core session).
