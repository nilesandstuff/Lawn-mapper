package app.routereader

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Route Reader's accessibility service (route session, 2026-11-19).
 *
 * Owner: a coworker "doesn't know how to take long screenshots" -- so a
 * button over the job list app that scrolls the list to the top, then reads
 * it page by page to the bottom, and hands the pages to the route planner.
 *
 * The service only acts when its button is tapped. Each page is read as the
 * TEXT on screen with where it sits (the accessibility tree), and the planner
 * reads those pages exactly as it reads screenshots (lib/parse.js), repeats
 * dropped. An app that shows no text to read (drawn as pictures) is
 * screenshotted page by page instead, and the planner reads the pictures.
 */
class ReaderService : AccessibilityService() {

    private val main = Handler(Looper.getMainLooper())
    private var button: TextView? = null
    private var params: WindowManager.LayoutParams? = null
    @Volatile private var busy = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        showButton()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* acts only on its button */ }
    override fun onInterrupt() {}

    override fun onDestroy() {
        button?.let { runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) } }
        button = null
        super.onDestroy()
    }

    /* ------------------------------------------------------------ the floating button */

    private fun showButton() {
        if (button != null) return
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val density = resources.displayMetrics.density
        val view = TextView(this).apply {
            text = "Read route"
            setTextColor(Color.WHITE)
            textSize = 15f
            val pad = (12 * density).toInt()
            setPadding(pad + pad / 2, pad, pad + pad / 2, pad)
            background = GradientDrawable().apply {
                cornerRadius = 40 * density
                setColor(Color.parseColor("#1F7A4D"))
                setStroke((2 * density).toInt(), Color.WHITE)
            }
            elevation = 8 * density
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = (12 * density).toInt()
            y = (resources.displayMetrics.heightPixels * 0.62).toInt()
        }
        // drag it out of the way; a tap without moving reads the route
        var downY = 0f
        var startY = 0
        var moved = false
        view.setOnTouchListener { v, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { downY = e.rawY; startY = lp.y; moved = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dy = e.rawY - downY
                    if (abs(dy) > 12 * density) moved = true
                    if (moved) { lp.y = (startY + dy).toInt().coerceAtLeast(0); wm.updateViewLayout(v, lp) }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!moved) readRoute(); true }
                else -> false
            }
        }
        wm.addView(view, lp)
        button = view
        params = lp
    }

    private fun say(text: String) = main.post { button?.text = text }

    private fun setButtonVisible(visible: Boolean) {
        val latch = CountDownLatch(1)
        main.post { button?.visibility = if (visible) View.VISIBLE else View.INVISIBLE; latch.countDown() }
        latch.await(1, TimeUnit.SECONDS)
    }

    /* ------------------------------------------------------------ reading */

    private fun readRoute() {
        if (busy) return
        busy = true
        Thread {
            try {
                val result = Reader(this).read { msg -> say(msg) }
                if (result == null) {
                    say("Nothing to read")
                    main.postDelayed({ say("Read route") }, 3000)
                    return@Thread
                }
                say("Sending…")
                val id = Handoff.send(BuildConfig.PLANNER_URL, result)
                val url = "${BuildConfig.PLANNER_URL}/#handoff=$id"
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                say("Read route")
            } catch (e: Exception) {
                say("Failed: ${e.message?.take(40) ?: "error"}")
                main.postDelayed({ say("Read route") }, 5000)
            } finally {
                busy = false
            }
        }.start()
    }

    /** The app on screen under the button: the topmost application window that is not ours. */
    fun appRoot(): AccessibilityNodeInfo? {
        val mine = packageName
        val apps = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
        for (w in apps.sortedByDescending { it.layer }) {
            val root = w.root ?: continue
            if (root.packageName?.toString() != mine) return root
        }
        return rootInActiveWindow?.takeIf { it.packageName?.toString() != mine }
    }

    /** A swipe from y1 to y2 at x; slow enough not to fling, so the distance is the distance. */
    fun swipe(x: Float, y1: Float, y2: Float, ms: Long = 450): Boolean {
        val path = Path().apply { moveTo(x, y1); lineTo(x, y2) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        val latch = CountDownLatch(1)
        var ok = false
        val sent = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(g: GestureDescription?) { ok = true; latch.countDown() }
            override fun onCancelled(g: GestureDescription?) { latch.countDown() }
        }, main)
        if (!sent) return false
        latch.await(ms + 2000, TimeUnit.MILLISECONDS)
        return ok
    }

    /** A screenshot of the screen as JPEG (Android 11 and up), the button hidden from it. */
    fun screenshot(): ByteArray? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        setButtonVisible(false)
        Thread.sleep(120)
        val latch = CountDownLatch(1)
        var out: ByteArray? = null
        takeScreenshot(Display.DEFAULT_DISPLAY, { it.run() }, object : TakeScreenshotCallback {
            override fun onSuccess(shot: ScreenshotResult) {
                try {
                    val hw = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
                    val bmp = hw?.copy(Bitmap.Config.ARGB_8888, false)
                    shot.hardwareBuffer.close()
                    if (bmp != null) {
                        val buf = ByteArrayOutputStream()
                        bmp.compress(Bitmap.CompressFormat.JPEG, 82, buf)
                        out = buf.toByteArray()
                    }
                } finally { latch.countDown() }
            }
            override fun onFailure(code: Int) { latch.countDown() }
        })
        latch.await(4, TimeUnit.SECONDS)
        setButtonVisible(true)
        return out
    }

    companion object {
        fun boundsOf(n: AccessibilityNodeInfo): Rect = Rect().also { n.getBoundsInScreen(it) }
    }
}

/** What was read: pages of text with where it sat, or screenshots, for the planner. */
class ReadResult(val app: String, val width: Int, val height: Int, val pages: JSONArray, val images: List<ByteArray>) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("source", "android")
        put("app", app)
        put("width", width)
        put("height", height)
        put("pages", pages)
        put("images", JSONArray().apply { images.forEach { put(Base64.encodeToString(it, Base64.NO_WRAP)) } })
        put("sdk", Build.VERSION.SDK_INT)
        put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        put("version", BuildConfig.VERSION_NAME)
    }
}
