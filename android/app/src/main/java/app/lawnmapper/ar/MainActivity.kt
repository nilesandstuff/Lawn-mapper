package app.lawnmapper.ar

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.RecordingConfig
import com.google.ar.core.Track
import com.google.ar.core.Session
import org.json.JSONObject

/**
 * The whole app: ARCore's camera on a GLSurfaceView, the scan site's page in a transparent WebView over it, and the
 * bridge between them (Bridge.kt). Signing in happens once by pairing: the scan site in Chrome sends
 * lawnar://signin?t=<one-time code>, which this opens at the site's /api/app/claim (scan/src/app.js).
 */
class MainActivity : Activity() {
    lateinit var engine: ArEngine
    lateinit var recorder: Recorder
    /** Bridge 8: a walk's parts the app holds and sends (Parts.kt). */
    val parts: Parts by lazy { Parts.of(this, BuildConfig.SCAN_URL.trimEnd('/')) }
    private var recordingWalk: String? = null
    private var replayingWalk: String? = null
    private lateinit var gl: GLSurfaceView
    private lateinit var web: WebView
    private var session: Session? = null
    private var installRequested = false
    /** Bridge 6: the page's count of parts waiting to be sent (Bridge.partsPending). */
    @Volatile var partsLeft = 0
    private val base: String get() = BuildConfig.SCAN_URL.trimEnd('/')
    private val host: String get() = Uri.parse(base).host ?: ""
    /* THE READINGS PAGE IN THE APP (bridge 7; the owner, 2026-11-17: "display the readings page on a separate
       page/tab in the app so I don't need to flip back and forth between the browser and the app"). The water site's
       field readings (water.<home>/moisture), in a second WebView over the AR view, opened by the page's Readings
       button and closed by Back or the bar at its top. Its address is the scan site's with "water." for "scan."
       (both are the home domain's: scan/tools/prepare.mjs, water/tools/prepare.mjs); the sign-in is the same,
       the pairing's cookie being the whole home domain's (scan/src/app.js pairCookie). */
    private val readingsUrl: String? get() = if (host.startsWith("scan.")) "https://water.${host.removePrefix("scan.")}/moisture" else null
    private val readingsHost: String get() = Uri.parse(readingsUrl ?: "").host ?: ""
    private var readings: WebView? = null
    private var readingsBox: View? = null
    private lateinit var root: FrameLayout

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        engine = ArEngine { json -> web.post { web.evaluateJavascript("window.LawnARNative_onFrame&&window.LawnARNative_onFrame($json)") { engine.delivered() } } }
        gl = GLSurfaceView(this).apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 16, 0)
            setRenderer(engine)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setGeolocationEnabled(true)
            settings.userAgentString = "${settings.userAgentString} LawnAR/${BuildConfig.VERSION_NAME}"
            addJavascriptInterface(Bridge(this@MainActivity), "LawnARNative")
            // the page's renderer keeps its priority when the app is not on screen, so an upload is not starved (bridge 6)
            if (android.os.Build.VERSION.SDK_INT >= 26) setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            webChromeClient = object : WebChromeClient() {
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                    callback?.invoke(origin, Uri.parse(origin ?: "").host == host, false)
                }
                override fun onConsoleMessage(m: ConsoleMessage?): Boolean { android.util.Log.i("LawnAR.page", m?.message() ?: ""); return true }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val u = request?.url ?: return false
                    if (u.scheme == "https" && u.host == host) return false
                    openExternal(u.toString())
                    return true
                }
            }
            setDownloadListener { url, _, _, _, _ -> openExternal(url) }
        }
        WebView.setWebContentsDebuggingEnabled(true)
        root = FrameLayout(this).apply {
            addView(gl, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(root)
        askPermissions()
        open(intent)
        recorder = Recorder.of(this, base)
        recorder.sink = { event(it) }   // the background send's progress, to the page while it is open
        engine.onPlaybackEnd = { status -> event("{\"type\":\"playbackEnd\",\"status\":${quote(status)}}") }
        // a recording an earlier walk could not send (no signal, the app closed): sent now
        web.postDelayed({ recorder.sendAll() }, 5000)
        // bridge 8: a walk's parts the app holds (Parts.kt); what an earlier visit could not send goes now
        web.postDelayed({ parts.kick() }, 3000)
        // what only the dev build has (the USB thermal camera; src/dev/README.md); nothing in the store build
        try { Extras.install(this, web, base); Extras.intent(this, intent) } catch (e: Exception) { android.util.Log.w("LawnAR", "extras: ${e.message}") }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        open(intent)
        Extras.intent(this, intent)
    }

    /** The pairing link, or the page. */
    private fun open(intent: Intent?) {
        val d = intent?.data
        if (d != null && d.scheme == "lawnar" && d.host == "signin") {
            val t = d.getQueryParameter("t") ?: ""
            web.loadUrl("$base/api/app/claim?t=${Uri.encode(t)}")
        } else if (web.url == null) {
            web.loadUrl("$base/?app=1")
        }
    }

    private fun askPermissions() {
        // and the notifications (Android 13+): the background send's progress shows in one (1.12)
        val want = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION) +
            (if (android.os.Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray())
        val missing = want.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
    }

    fun event(json: String) { web.post { web.evaluateJavascript("window.LawnARNative_onEvent&&window.LawnARNative_onEvent($json)", null) } }

    private fun quote(s: String?) = JSONObject.quote(s ?: "")

    /** Start ARCore (on the UI thread), with the page's options. */
    fun startAr(json: String) {
        if (session != null) { event("{\"type\":\"started\",\"again\":true}"); return }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            askPermissions(); event("{\"type\":\"error\",\"message\":\"the camera permission is needed: allow it, then start again\"}"); return
        }
        try {
            if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true
                event("{\"type\":\"installing\",\"message\":\"Google Play Services for AR is being installed or updated; start again when it is done\"}")
                return
            }
            val o = try { JSONObject(json) } catch (e: Exception) { JSONObject() }
            // A REPLAY (bridge 3): the walk's recording fetched first, then ARCore runs on it instead of the camera
            val replayWalk = o.optString("playback", "").ifEmpty { null }
            val replayFile = replayWalk?.let { recorder.replayFile(it) }
            if (replayWalk != null && (replayFile == null || !replayFile.exists())) {
                event("{\"type\":\"fetching\",\"walk\":${quote(replayWalk)}}")
                recorder.fetch(replayWalk) { startAr(json) }
                return
            }
            engine.options = ArEngine.Options(
                grabW = o.optInt("grabW", 480).coerceIn(120, 1280), jpegQ = o.optInt("jpegQ", 80).coerceIn(30, 95), rgbaStep = o.optInt("rgbaStep", 1).coerceIn(1, 16),
                near = o.optDouble("near", 0.05).toFloat(), far = o.optDouble("far", 300.0).toFloat(),
                depthEveryMs = o.optLong("depthEveryMs", 200), pictureEveryMs = o.optLong("pictureEveryMs", 700), geoEveryMs = o.optLong("geoEveryMs", 1000),
                semEveryMs = o.optLong("semEveryMs", 500), anchorsEveryMs = o.optLong("anchorsEveryMs", 1000), planesEveryMs = o.optLong("planesEveryMs", 0),
            )
            val s = Session(this)
            // THE CAMERA MODE (1.10, 2026-11-08): the smallest picture ARCore offers unless the page asks for the largest.
            // The largest (1920x1080 on the S21) went into the walk's recording whole: 2.2 GB for an 8-minute walk, while
            // the page shrinks every picture to grabW (480) wide anyway. All the S21's modes share one camera and the
            // same 1920x1080 view; only the CPU picture's size differs.
            val configs: List<CameraConfig> = s.getSupportedCameraConfigs(CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK))
            val largest = o.optString("cameraImage", "smallest") == "largest"
            (if (largest) configs.maxByOrNull { it.imageSize.width * it.imageSize.height } else configs.minByOrNull { it.imageSize.width * it.imageSize.height })
                ?.let { try { s.cameraConfig = it } catch (_: Exception) { } }
            // every mode ARCore offers on this phone, told to the page (the owner, 2026-11-08: is the 1x camera the best,
            // or the widest?): its camera, picture and texture sizes, frame rates, depth sensor and stereo use
            val modes = configs.joinToString(",", "[", "]") { c ->
                "{\"camera\":${quote(c.cameraId)},\"image\":\"${c.imageSize.width}x${c.imageSize.height}\",\"texture\":\"${c.textureSize.width}x${c.textureSize.height}\",\"fps\":\"${c.fpsRange.lower}-${c.fpsRange.upper}\",\"depthSensor\":${quote(c.depthSensorUsage.name)},\"stereo\":${quote(c.stereoCameraUsage.name)}}"
            }
            val c = Config(s).apply {
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
                focusMode = Config.FocusMode.AUTO
                lightEstimationMode = Config.LightEstimationMode.DISABLED
                planeFindingMode = if (o.optBoolean("planes", true)) Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL else Config.PlaneFindingMode.DISABLED
            }
            val depth = o.optBoolean("depth", true) && s.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
            if (depth) c.depthMode = Config.DepthMode.AUTOMATIC
            var geo = o.optBoolean("geospatial", true) && BuildConfig.GEO_KEY && s.isGeospatialModeSupported(Config.GeospatialMode.ENABLED)
            var geoWhy: String? = null
            if (geo) c.geospatialMode = Config.GeospatialMode.ENABLED
            // GEOSPATIAL DEPTH (bridge 3; developers.google.com/ar/develop/java/depth/geospatial-depth): with Geospatial
            // and Streetscape Geometry on and depth AUTOMATIC, ARCore's depth reaches 65 m where Google has VPS
            var street = geo && depth && o.optBoolean("streetscape", true)
            var streetWhy: String? = null
            if (street) c.streetscapeGeometryMode = Config.StreetscapeGeometryMode.ENABLED
            // Scene Semantics (bridge 2): not every phone has it; outdoor pictures only
            var sem = o.optBoolean("semantics", true) && s.isSemanticModeSupported(Config.SemanticMode.ENABLED)
            var semWhy: String? = null
            if (sem) c.semanticMode = Config.SemanticMode.ENABLED
            // Geospatial and semantics are bonuses: without them the walk still runs (the reasons go to the page)
            try {
                try { s.configure(c) } catch (e0: Exception) {
                    if (!street) throw e0
                    street = false; streetWhy = e0.javaClass.simpleName
                    c.streetscapeGeometryMode = Config.StreetscapeGeometryMode.DISABLED
                    s.configure(c)
                }
            } catch (e: Exception) {
                if (!sem && !geo) throw e
                try {
                    if (!sem) throw e
                    sem = false; semWhy = e.javaClass.simpleName
                    c.semanticMode = Config.SemanticMode.DISABLED
                    s.configure(c)
                } catch (e2: Exception) {
                    if (!geo) throw e2
                    geo = false; geoWhy = e2.javaClass.simpleName
                    c.geospatialMode = Config.GeospatialMode.DISABLED
                    s.configure(c)
                }
            }
            // replay or record: both set before the session first resumes (ARCore Recording & Playback)
            var recWhy: String? = null
            recordingWalk = null
            replayingWalk = null
            if (replayFile != null) {
                s.setPlaybackDatasetUri(Uri.fromFile(replayFile))
                replayingWalk = replayWalk
            } else o.optString("record", "").ifEmpty { null }?.let { walk ->
                try {
                    val rc = RecordingConfig(s).setMp4DatasetUri(Uri.fromFile(recorder.fileFor(walk))).setAutoStopOnPause(true)
                        .addTrack(Track(s).setId(ArEngine.TRACK).setMimeType("application/json"))
                    s.startRecording(rc)
                    recordingWalk = walk
                } catch (e: Exception) { recWhy = e.javaClass.simpleName + ": " + (e.message ?: "") }
            }
            s.resume()
            session = s
            engine.reset()
            engine.geoOn = geo
            engine.semOn = sem
            engine.bothDepths = street
            engine.recording = recordingWalk != null
            engine.playback = replayFile != null
            engine.session = s
            val img = s.cameraConfig.imageSize
            event("{\"type\":\"started\",\"depth\":$depth,\"geospatial\":$geo${if (geoWhy != null) ",\"geoError\":${quote(geoWhy)}" else ""},\"semantics\":$sem${if (semWhy != null) ",\"semError\":${quote(semWhy)}" else ""},\"image\":\"${img.width}x${img.height}\",\"camera\":${quote(s.cameraConfig.cameraId)},\"modes\":$modes,\"streetscape\":$street${if (streetWhy != null) ",\"streetError\":${quote(streetWhy)}" else ""},\"recording\":${recordingWalk != null}${if (recWhy != null) ",\"recordError\":${quote(recWhy)}" else ""},\"replay\":${quote(replayWalk)}}")
        } catch (e: Exception) {
            session = null
            event("{\"type\":\"error\",\"message\":${quote(e.javaClass.simpleName + ": " + (e.message ?: ""))}}")
        }
    }

    fun stopAr() {
        val s = session ?: run { event("{\"type\":\"end\"}"); return }
        session = null
        engine.session = null
        engine.geoOn = false
        engine.semOn = false
        val rec = recordingWalk
        recordingWalk = null
        val replayed = replayingWalk
        replayingWalk = null
        engine.recording = false
        engine.playback = false
        // past the GL thread's current frame (it reads engine.session afresh each frame), then off it: closing ARCore
        // takes a second or more, and on the GL thread that froze the last camera picture on screen (owner, 2026-11-07)
        gl.queueEvent { Thread {
            try { if (rec != null) s.stopRecording() } catch (_: Exception) { }
            try { s.pause(); s.close() } catch (_: Exception) { }
            // a replay's download, with keep off: off the phone once it has been replayed
            if (replayed != null && !recorder.keep && recorder.isSent(replayed)) recorder.remove(replayed)   // never one not yet on the site
            if (rec != null) {
                // the MP4 is finished once recording stops: told to the page, then sent to the site
                event("{\"type\":\"recorded\",\"walk\":${quote(rec)},\"bytes\":${recorder.fileFor(rec).length()}}")
                recorder.sendAll()
            }
        }.start() }
        event("{\"type\":\"end\"}")
    }

    /** The readings page shown over the AR view (made the first time; kept, with what is typed in it, after), or hidden. */
    @SuppressLint("SetJavaScriptEnabled")
    fun showReadings(show: Boolean) {
        val url = readingsUrl ?: return
        if (!show) { readingsBox?.visibility = View.GONE; return }
        if (readings == null) {
            val w = WebView(this).apply {
                setBackgroundColor(Color.WHITE)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.setGeolocationEnabled(true)
                settings.userAgentString = "${settings.userAgentString} LawnAR/${BuildConfig.VERSION_NAME}"
                webChromeClient = object : WebChromeClient() {
                    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                        callback?.invoke(origin, Uri.parse(origin ?: "").host == readingsHost, false)
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val u = request?.url ?: return false
                        if (u.scheme == "https" && u.host == readingsHost) return false
                        openExternal(u.toString())
                        return true
                    }
                }
                setDownloadListener { u, _, _, _, _ -> openExternal(u) }
                // what only the dev build adds to the readings page too (src/dev/README.md); nothing in the store build
                try { Extras.readings(this) } catch (e: Exception) { android.util.Log.w("LawnAR", "extras: ${e.message}") }
                loadUrl(url)
            }
            val back = android.widget.Button(this).apply {
                text = "\u2190 Yard AR"
                isAllCaps = false
                setOnClickListener { showReadings(false) }
            }
            val box = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                setBackgroundColor(Color.WHITE)
                addView(back, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT))
                addView(w, android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            }
            root.addView(box, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            readings = w; readingsBox = box
        }
        readingsBox?.visibility = View.VISIBLE
    }

    fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
    }

    override fun onResume() {
        super.onResume()
        try { session?.resume() } catch (_: Exception) { }
        gl.onResume()
        web.onResume()
        readings?.onResume()
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    override fun onPause() {
        super.onPause()
        gl.onPause()
        session?.pause()
        // bridge 6: a page with a walk's parts still to send is left running (PartsService keeps the process awake);
        // paused, its upload stopped until the app was opened again (12 minutes on the owner's walk of 2026-11-12)
        if (partsLeft == 0) web.onPause()
        readings?.onPause()
    }

    override fun onDestroy() {
        recorder.sink = null   // a send in the background carries on, with no page to tell
        Extras.destroy()
        session?.close()
        session = null
        web.destroy()
        readings?.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val r = readings
        if (readingsBox?.visibility == View.VISIBLE && r != null) { if (r.canGoBack()) r.goBack() else showReadings(false); return }
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }
}
