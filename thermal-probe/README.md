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
