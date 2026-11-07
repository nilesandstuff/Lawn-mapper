package app.lawnmapper.ar

import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import com.google.ar.core.ArCoreApk

/**
 * What the page can call, as window.LawnARNative (scan/lib/track.js, engine "native"). Every answer is a string (JSON
 * where it has parts). BRIDGE in build.gradle.kts counts its versions: a page that needs a newer one says so and offers
 * the update (scan/public/app.js). Keep each call general -- what to do with the camera belongs in the page.
 *
 * The other way, the app calls window.LawnARNative_onFrame(frame) about 30 times a second and
 * window.LawnARNative_onEvent(event) for started / installing / error / end.
 */
class Bridge(private val a: MainActivity) {

    /** The app and the phone: { app, code, bridge, geoKey, arcore, device, android }. */
    @JavascriptInterface
    fun info(): String {
        val avail = try { ArCoreApk.getInstance().checkAvailability(a).name } catch (e: Exception) { "UNKNOWN" }
        val dev = "${Build.MANUFACTURER} ${Build.MODEL}".replace("\"", "")
        return "{\"app\":\"${BuildConfig.VERSION_NAME}\",\"code\":${BuildConfig.VERSION_CODE},\"bridge\":${BuildConfig.BRIDGE}," +
            "\"geoKey\":${BuildConfig.GEO_KEY},\"arcore\":\"$avail\",\"device\":\"$dev\"," +
            "\"android\":${Build.VERSION.SDK_INT}}"
    }

    /**
     * Start ARCore with the page's options (JSON, all optional): { grabW, jpegQ, near, far, depthEveryMs,
     * pictureEveryMs, geoEveryMs, semEveryMs, anchorsEveryMs, depth: true, geospatial: true, semantics: true,
     * planes: true }. Answers at once; how it went comes
     * as an event.
     */
    @JavascriptInterface
    fun start(json: String): String { a.runOnUiThread { a.startAr(json) }; return "ok" }

    @JavascriptInterface
    fun stop(): String { a.runOnUiThread { a.stopAr() }; return "ok" }

    /** Where on the screen (0..1, 0..1) the crosshair is, for the hit test sent with each frame. */
    @JavascriptInterface
    fun setCross(x: Float, y: Float) { a.engine.crossX = x; a.engine.crossY = y }

    /** The latest depth as a grid over the screen (DepthSnapshot.gridJson); kind "raw" or "smooth"; null when none. */
    @JavascriptInterface
    fun depthGrid(nx: Int, ny: Int, kind: String, minConf: Int): String {
        val d = if (kind == "smooth") a.engine.depthSmooth else a.engine.depthRaw ?: a.engine.depthSmooth
        return d?.gridJson(nx.coerceIn(1, 200), ny.coerceIn(1, 400), minConf) ?: "null"
    }

    /**
     * Bridge 2: an ARCore anchor at a session point; answers its id at once (made with the next frame), or -1 when too
     * many are held. Where ARCore puts each anchor comes with the frames: "anchors": [[id, x, y, z, state], ...].
     */
    @JavascriptInterface
    fun anchor(x: Float, y: Float, z: Float): Int = a.engine.askAnchor(x, y, z)

    /** Bridge 2: let an anchor go (ARCore stops spending on it). */
    @JavascriptInterface
    fun dropAnchor(id: Int) { a.engine.dropAnchor(id) }

    /** The latest camera picture as the screen shows it (Picture.json): RGBA and JPEG, base64; null when none yet. */
    @JavascriptInterface
    fun grab(): String = a.engine.picture?.json() ?: "null"

    /** Open a link outside the app (Chrome): the update's download, a page off the scan site. */
    @JavascriptInterface
    fun openExternal(url: String) { a.runOnUiThread { a.openExternal(url) } }

    @JavascriptInterface
    fun log(msg: String) { Log.i("LawnAR", msg.take(500)) }
}
