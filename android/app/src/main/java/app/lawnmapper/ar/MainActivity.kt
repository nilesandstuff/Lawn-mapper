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
import com.google.ar.core.Session
import org.json.JSONObject

/**
 * The whole app: ARCore's camera on a GLSurfaceView, the scan site's page in a transparent WebView over it, and the
 * bridge between them (Bridge.kt). Signing in happens once by pairing: the scan site in Chrome sends
 * lawnar://signin?t=<one-time code>, which this opens at the site's /api/app/claim (scan/src/app.js).
 */
class MainActivity : Activity() {
    lateinit var engine: ArEngine
    private lateinit var gl: GLSurfaceView
    private lateinit var web: WebView
    private var session: Session? = null
    private var installRequested = false
    private val base: String get() = BuildConfig.SCAN_URL.trimEnd('/')
    private val host: String get() = Uri.parse(base).host ?: ""

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
        setContentView(FrameLayout(this).apply {
            addView(gl, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        })
        askPermissions()
        open(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        open(intent)
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
        val want = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
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
            engine.options = ArEngine.Options(
                grabW = o.optInt("grabW", 480).coerceIn(120, 1280), jpegQ = o.optInt("jpegQ", 80).coerceIn(30, 95),
                near = o.optDouble("near", 0.05).toFloat(), far = o.optDouble("far", 300.0).toFloat(),
                depthEveryMs = o.optLong("depthEveryMs", 200), pictureEveryMs = o.optLong("pictureEveryMs", 700), geoEveryMs = o.optLong("geoEveryMs", 1000),
            )
            val s = Session(this)
            // the camera mode with the largest picture the phone offers (the page's pictures are cut from it)
            val configs: List<CameraConfig> = s.getSupportedCameraConfigs(CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK))
            configs.maxByOrNull { it.imageSize.width * it.imageSize.height }?.let { s.cameraConfig = it }
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
            try {
                s.configure(c)
            } catch (e: Exception) {
                if (!geo) throw e
                // Geospatial is a bonus: without it the walk still runs (the reason goes to the page)
                geo = false
                geoWhy = e.javaClass.simpleName
                c.geospatialMode = Config.GeospatialMode.DISABLED
                s.configure(c)
            }
            s.resume()
            session = s
            engine.geoOn = geo
            engine.session = s
            val img = s.cameraConfig.imageSize
            event("{\"type\":\"started\",\"depth\":$depth,\"geospatial\":$geo${if (geoWhy != null) ",\"geoError\":${quote(geoWhy)}" else ""},\"image\":\"${img.width}x${img.height}\"}")
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
        // past the GL thread's current frame (it reads engine.session afresh each frame), then off it: closing ARCore
        // takes a second or more, and on the GL thread that froze the last camera picture on screen (owner, 2026-11-07)
        gl.queueEvent { Thread { try { s.pause(); s.close() } catch (_: Exception) { } }.start() }
        event("{\"type\":\"end\"}")
    }

    fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
    }

    override fun onResume() {
        super.onResume()
        try { session?.resume() } catch (_: Exception) { }
        gl.onResume()
        web.onResume()
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    override fun onPause() {
        super.onPause()
        gl.onPause()
        session?.pause()
        web.onPause()
    }

    override fun onDestroy() {
        session?.close()
        session = null
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }
}
