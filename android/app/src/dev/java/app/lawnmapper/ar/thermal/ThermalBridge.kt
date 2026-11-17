package app.lawnmapper.ar.thermal

import android.webkit.JavascriptInterface

/**
 * DEV ONLY -- what the page can ask of the thermal camera, as window.LawnARThermal (scan/public/thermal.js, which
 * loads only when this exists). Absent from the store build.
 */
class ThermalBridge(private val cam: ThermalCamera) {
    /** { state, detail, secs, busy, present, setup, fps, seen, refs, refAgoS, walk, kept, dropped, bytes, upload } */
    @JavascriptInterface fun status(): String = cam.status()
    /** Look for the camera and set it up (also done when it is plugged in and when the app opens). */
    @JavascriptInterface fun connect() { cam.connect() }
    /** Keep frames for this walk; false when no camera is connected. */
    @JavascriptInterface fun startWalk(walk: String): Boolean = cam.startWalk(walk)
    @JavascriptInterface fun endWalk() { cam.endWalk() }
    /** A fresh reference, then the 10 s sky sweep (every frame); label "start" or "end". */
    @JavascriptInterface fun skyShot(label: String): Boolean = cam.skyShot(label)
    /** 5 s of every frame, for the timing sweep past something hot. */
    @JavascriptInterface fun sweep(): Boolean = cam.sweep()
    /** A mark in the walk's file with its time ("angle-start", "angle-end"); false when no walk is recording. */
    @JavascriptInterface fun mark(what: String): Boolean = cam.mark(what)
    @JavascriptInterface fun sendWaiting() { cam.uploads.sendAll() }
    /**
     * A single thermal photo (ThermalCamera.snap): about 4 s, the owner holding still for the middle second. json, all
     * optional: { map, coarse: { lng, lat } (rounded to 0.1 here), air_C, emissivity, label }. Answers
     * { ok, id } at once, or { ok: false, why }; status() says when it is done (snap, snapError).
     */
    @JavascriptInterface fun snap(json: String): String = cam.snap(json)
    /** The setup's notes, when it failed. */
    @JavascriptInterface fun log(): String = cam.log()
}
