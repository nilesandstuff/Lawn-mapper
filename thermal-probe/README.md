# Thermal probe

A throwaway Android test app (thermal session, 2026-11-13). The question it answers: can our own app read the
AccuMEMS SK02 phone thermal camera directly, without the AccuHeat app, so a thermal walk can be recorded during a
Yard AR walk with ARCore's pose on every thermal frame?

## What is known before it runs

- AccuMEMS is a rebrand of HIKMICRO (Hikvision): the AccuHeat APK is HIKMICRO's Viewer, and AccuStudio is built on
  Hikvision's HCNetSDK / HCUSBSDK. The SK02's native sensor is 256x192 at 25 Hz (512x384 is upscaling).
- On the owner's phone the SK02 enumerates as `38BE:0184` "AccuMEMS Thermal Imager": class EF/02/01, one
  configuration with a Video Control interface (0E/01, interrupt 0x82) and a Video Streaming interface (0E/02)
  whose alt 0 has a BULK IN endpoint 0x81 (512-byte packets). A plain UVC camera; no vendor-class interface.
- A generic USB webcam app showed green static with a pink line at the bottom: what 16-bit numbers look like when
  read as YUYV (the high byte, small and nearly constant, lands in the colour channels). So the default stream is
  probably raw per-pixel counts plus a few metadata rows. Not yet confirmed.

## What it does

Kotlin, no libraries: Android's own USB host API speaks UVC (bulk streaming needs no libusb). `Uvc.kt` reads the
descriptors, reads (never writes) every control the units list, negotiates a stream (probe/commit) and assembles
frames from the bulk payloads. `MainActivity.kt` is one screen: Connect, a preview that guesses 16-bit pixels,
labelled one-second captures (Sky, Hand, Ice water, Other), shutter open/close and a flat-field (Uvc.shutter:
XU 10, wValue 8 open, 9 close, 10 release), and Save & share, which zips everything
into Download/ThermalProbe.

The zip holds `descriptors.hex` (every byte of the device's descriptors), `controls.txt`, `payload-headers.txt` (the
first 40 payloads' headers), `log.txt`, and for every capture a `.bin` (the frames back to back, as sent) and a
`.csv` (each frame's size, Android's elapsedRealtime when it was complete, the UVC PTS/SCR).

## Building and installing

Workflow "T. Thermal probe" builds on any push that changes `thermal-probe/` and publishes the APK as the release
`thermal-probe-latest`. It is signed with `debug.keystore` here (a probe-only key, password "android"), so a new
build installs over the old one.

## Findings

- Run 1 (0.2, 2026-11-13): the camera streams to our own app with no handshake: 264x222 16-bit little-endian, 25
  fps, payloads with 16-byte headers (2 standard + 14 vendor bytes). Rows 215-221 and columns 256-263 are not
  picture. The numbers are RAW detector counts: the phone app (HIKMICRO's libhikdsp / libifrnuc) does the
  non-uniformity correction, and the shutter is driven by the host.
- The hand and ice-water captures were identical but for a uniform drift of 12-40 counts, because the shutter was
  closed the whole time: nothing told it to open. r216[1] and r216[5] rose steadily across the session (likely the
  sensor warming up).
- The shutter command, from libusbCam_host.so hal_usbcam_host_shutter_ctrl and libhikdsp.so ST_TurnOn/OffShutter:
  a zero-length SET_CUR (bmRequestType 0x21, bRequest 1) to wIndex = (extension unit 10 << 8) | interface 0, with
  the command in wValue: 9 close, 8 open, then 10 to release the drive 140 ms later.
- Run 3 (0.3): the libusbCam_host commands were accepted (8 and 9 returned 0) but 10 stalled and nothing moved.
  That library is for other HIKMICRO cameras: AccuHeat's Java (decompiled with the owner's permission) sends VID
  14526 / PID 388 through com.guardexpert.microsensorsdk, which drives the camera through libHCUSBSDK.so.
- HIKMICRO's manual correction (USB_SET_IMAGE_MANUAL_CORRECT, 2025) decoded from libHCUSBSDK.so: SET_CUR (0x21,
  0x01), wValue 0x0200, wIndex 0, data 03 88 04 (ProtocolStrategyUvc10; CUsbDriverLibuvc reads wValue from setup
  bytes 4-5, wIndex from 6-7). The probe's Correct A sends exactly that; Correct B the same to wIndex 0x0A00.
- Run 4 (0.5): both forms of the manual correction were accepted (3 bytes written) and nothing clicked; no frame
  shows a scene. Every vendor GET answers one 00 byte whatever is asked, which looks like a placeholder. The likely
  reason: AccuHeat logs in first (MicroSensorUVC.login with the device's fd, then libHCUSBSDK's USB_Login, which
  carries ECDH/AES machinery), and the camera may ignore commands until then. Not yet decoded.
- Run 5 (0.5, AccuHeat opened first and closed, camera left plugged in): the probe saw the scene. The shutter is a
  latch AccuHeat leaves open; the sensor and our stream are fine, only control is missing. Flat-field then
  photographed the open scene (no shutter moved), which is the "burn-in" the owner saw.
- The login is not a handshake for this camera: libHCUSBSDK's CUsbCommandLogin only runs the ACS login for device
  types 1 and 2; for UVC thermal it just opens the device.
- The same DeviceConfig protocol is documented for the Topdon TC002C (HIKMICRO-built) in
  github.com/3ricj/IRPanoView, MasterThermoDocs (no licence file: its protocol facts are used, its code is not).
  Extension unit wIndex 0x0A00; PROBE 0x85 / GET 0x81 / SET 0x01; channels 0x0500 select, 0x0200 image, 0x0600
  state; a bind sequence before commands; manual shutter = select 02 04, SET 0x0200 with a 12-byte
  USB_COMMON_COND (size 12, channel 1), poll 0x0600 until 1. The SK02's extension unit has the same channels (its
  0x0400 reads "2.0"). Probe 0.6 binds on connect and adds Hik shutter.
- Run 6 (0.7): the bind works (device info 488 B: APP_010012_BUILD_20260828, camera id 065356AA00, an AY1 / TJ11
  module; hardware server 01 02 02). The TC002C manual shutter (select 02 04, SET 0x0200) was accepted but left the
  command state at 9 and moved nothing.
- The SK01 (owner's correction: it is the SK01, 192x144 native, not the SK02) drives its shutter through
  burn prevention: libMicroDM AY1Version::setShutterControl(1..3) writes byBurnPreventionShutterControl (host
  offset 0x5C of USB_IMAGE_ENHANCEMENT_EX; 1 none, 2 close, 3 open, manual mode only) and SETs command 2080
  (route 02 05, channel 0x0200). Wire block 226 B (libHCUSBSDK ConvertData / ParseRecvData): 0x29 enabled,
  0x2A mode (1 auto, 2 manual), 0x2F shutter control. Probe 0.8: SK01 close / open / Read block; Flat-field uses it.
- Run 7 (0.8, 2026-11-13): THE SHUTTER WORKS. SK01 close / open click; the camera answers the burn-prevention
  write with no command state (0) and a 186-byte GET block that is all zeros but its first byte. Opening shows
  in the stream 2 frames (~80 ms) after the command. Flat-field (close, 10 frames averaged, open) gives a clean
  picture: the scene occupies rows 0-195 and columns 0-259 of the 264x222 frame; columns 260-263 and rows
  196-221 are not picture (rows 196-216 near-constant, 218-221 metadata). Temporal noise with the shutter closed:
  10.2 counts per pixel per frame. Counts-to-temperature calibration not yet done.

## Calibration mode (0.9)

Record point: a fresh flat-field (shutter closed, 10 frames, opened), then one second of the target, and one line
of calib.jsonl: the target, the readings typed in (a known temperature: ice water 0 C or a taped sealed bottle at the air thermometer's reading; the IR gun; AccuHeat's spot reading of the same target, which is HIKMICRO's factory calibration of this camera), seconds since connect, and the
11x11 box at the centre of the picture as raw counts for the shutter and for the scene, and their difference.
Warm-up log repeats it every 30 s on one target, for the drift while the camera warms. Both captures of every
point are kept as .bin, so the fit can be redone on any box or the whole frame.

Emissivity is not a camera setting here: the SK01 sends raw counts and the phone does all thermometry, so the
grass emissivity (0.98), the reflected sky, and the view angle all belong in our own conversion, fitted from these
points.
- Run 9 (0.11, outdoors, very cold): three points saved: sky (IR gun -38 C) 2474 and 3352 counts below the
  shutter (box sd 418 and 834: the sky in the box was not uniform), grass 2946 below. The grass point carries the
  sky's IR-gun value (the field was not cleared; 0.12 clears the readings after each point).

## AccuHeat radiometric photos (2026-11-13)

AccuHeat's original JPEGs carry HIKMICRO's data in APP2/APP3 segments tagged `42 40 00 83`: a JSON measurement
record (temperatures in 1/8192 C, each with its "Gray"; emissivity, reflected and atmospheric temperature,
distance), the 192x144 Gray grid as u16 at offset 90 of APP3 block 5 (followed by a copy of the frame's metadata
row: the same fields as our row 216), a palette, ISP file names, and a 14.5 KB thermometry calibration block
(APP2 block 2) that is identical in every photo: the camera's factory calibration. The photos and that block hold
the camera's serial and stay out of this repository. Chat attachments may be re-encoded and lose all of this;
originals go through Drive.

Findings from seven photos and one probe capture of the same propped scene (ice water, hot water):
- HIKMICRO's 192x144 is a 1:1 CROP of our 260x196 picture, at about column 35, row 24 (the centre). The SK01 has
  pixels beyond its 192x144 that AccuHeat does not measure.
- Pixel for pixel, Gray = ~0.9 x our flat-fielded counts + an offset (correlation 0.985-0.990; residual 0.7-1.2 C
  including a minute of scene change between the shots; twice that without our flat-field). The offset moves with
  the camera's state.
- Gray-to-temperature is not fixed: the same Gray read 0.1 C in one photo and 0.25 C at 300 Gray lower in another;
  the spacing is stable (~84 Gray per C between ice and ~50 C water).
- Our metadata row 216 is the field HIKMICRO stores after the grid: [1] and [2] a sensor temperature that rises
  as the camera warms (996 outdoors cold, 1238-1455 indoors), [0] filled by AccuHeat (the value at its last
  shutter). The units are not yet known.
- The first photo after our probe had used the camera read ~13 C low (hot water 35.9 C); a minute later AccuHeat
  was normal again. Calibration photos taken right after switching apps are left out.
- UIRA-IR (AccuHeat's enhancement) does not change the stored Gray grid (same pixel noise, ~3 Gray, in all seven;
  the setting is not even recorded): display only.

## HIKMICRO's temperature conversion, reproduced (2026-11-13)

With the owner's permission HIKMICRO's thermometry libraries (libMTlib, libMicroTA) were decompiled with Ghidra
and the SK01's conversion from Gray to temperature was rebuilt in Python from it and the camera's own factory
calibration file (the block every AccuHeat photo carries). It reproduces every temperature AccuHeat stored in
nine photos to 0.0001 C (points and area averages). The reimplementation and the calibration data stay out of
this public repository (they are HIKMICRO-derived and carry the camera's serial); only these findings are here.

- The chain is the standard radiometric one: Gray minus a per-frame base level, a quadratic response correction
  whose coefficients depend on the sensor temperature, Planck's law inverted with four factory constants, then
  emissivity, reflected temperature, and a LOWTRAN-style atmospheric transmission (distance, humidity).
- The sensor temperature is metadata row 216 word [1], 14 bits x 0.02 C (28.42 C in a probe frame).
- AccuHeat's per-frame base level is computed on the phone (it is zero in our raw frames). It falls ~88 Gray per
  C of sensor temperature. The photo AccuHeat took just after our app had the camera (its "13 C low" one) is
  reproduced exactly from its own base level: AccuHeat itself was wrong there, not our reading of it.
- Linking our counts: Gray = k x (our counts above the shutter) + the shutter's Gray. Two photo/probe pairs give
  k 0.94 and 0.88 and a shutter apparent temperature of 30.5-32 C against a sensor temperature of 28.4 C, with
  0.8-1.2 C residuals; the scene (water cooling, ice moving) changed between the shots, so k and the shutter
  temperature still need a static, temperature-stable scene to pin down.
