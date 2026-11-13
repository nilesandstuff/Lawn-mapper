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
labelled one-second captures (Sky, Hand, Ice water, Other), a survey of every format and size, one optional write
(the zoom control set to 0x8004, a raw-mode command on some thermal cores), and Save & share, which zips everything
into Download/ThermalProbe.

The zip holds `descriptors.hex` (every byte of the device's descriptors), `controls.txt`, `payload-headers.txt` (the
first 40 payloads' headers), `log.txt`, and for every capture a `.bin` (the frames back to back, as sent) and a
`.csv` (each frame's size, Android's elapsedRealtime when it was complete, the UVC PTS/SCR).

## Building and installing

Workflow "T. Thermal probe" builds on any push that changes `thermal-probe/` and publishes the APK as the release
`thermal-probe-latest`. It is signed with `debug.keystore` here (a probe-only key, password "android"), so a new
build installs over the old one.
