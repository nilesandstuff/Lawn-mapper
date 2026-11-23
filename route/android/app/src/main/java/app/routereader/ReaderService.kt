package app.routereader

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.provider.Settings
import android.widget.Toast
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
import android.widget.LinearLayout
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
    private var panel: LinearLayout? = null // the window: the menu (when open) and the button
    private var button: TextView? = null
    private var menu: LinearLayout? = null
    private var params: WindowManager.LayoutParams? = null
    @Volatile private var busy = false

    /*
     * WHERE THE BUTTON SHOWS (owner, 2026-11-19: "the button also won't go away"). Over the job list
     * app only: the app of the first read that went to the planner, kept in "app". Before that, over
     * any app but the home screen.
     *
     * WHAT IT DOES (owner, 2026-11-23: "after a route has been loaded on a day, the read route button
     * opens the planner instead ... it's present every time it's opened, which is pretty annoying").
     * Before the day's first read it is the green Read route; after it, a small Planner that opens the
     * planner (which keeps the day's route). A long press opens a menu: Read again (after a read),
     * Hide today (until tomorrow), Hide for now (until the job app is opened again).
     */
    private val prefs: SharedPreferences by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private val prefsChanged = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> updateVisibility() }
    private var current: String? = null
    private var hiddenFor: String? = null

    private fun today(): String = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
    private fun readToday() = prefs.getString(KEY_READ_DAY, null) == today()

    override fun onServiceConnected() {
        super.onServiceConnected()
        showButton()
        prefs.registerOnSharedPreferenceChangeListener(prefsChanged)
        current = rootInActiveWindow?.packageName?.toString()
        updateVisibility()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        // the shade, a keyboard, or this app's own windows do not change which app you are in
        if (pkg == packageName || pkg == "com.android.systemui" || isKeyboard(pkg)) return
        if (pkg != current) {
            current = pkg
            if (hiddenFor != null && hiddenFor != pkg) hiddenFor = null
            closeMenu()
        }
        updateVisibility()
    }

    private fun isKeyboard(pkg: String) =
        Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.startsWith("$pkg/") == true

    private fun homeApp(): String? = packageManager
        .resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)
        ?.activityInfo?.packageName

    private fun updateVisibility() {
        val app = prefs.getString(KEY_APP, null)
        val here = current
        val hiddenToday = prefs.getString(KEY_HIDDEN_DAY, null) == today()
        val show = hiddenFor == null && !hiddenToday && here != null && (if (app != null) here == app else here != homeApp())
        main.post {
            panel?.visibility = if (show || busy) View.VISIBLE else View.GONE
            if (!busy) styleButton()
        }
    }
    override fun onInterrupt() {}

    override fun onDestroy() {
        runCatching { prefs.unregisterOnSharedPreferenceChangeListener(prefsChanged) }
        panel?.let { runCatching { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) } }
        panel = null
        button = null
        super.onDestroy()
    }

    /* ------------------------------------------------------------ the floating button */

    private fun pill(text: String, filled: Boolean, size: Float): TextView {
        val density = resources.displayMetrics.density
        return TextView(this).apply {
            this.text = text
            textSize = size
            val pad = (10 * density).toInt()
            setPadding(pad + pad / 2, pad, pad + pad / 2, pad)
            elevation = 8 * density
            setTextColor(if (filled) Color.WHITE else Color.parseColor("#1F7A4D"))
            background = GradientDrawable().apply {
                cornerRadius = 40 * density
                setColor(Color.parseColor(if (filled) "#1F7A4D" else "#FFFFFF"))
                setStroke((2 * density).toInt(), if (filled) Color.WHITE else Color.parseColor("#1F7A4D"))
            }
        }
    }

    /** Read route (green) before the day's first read; a small white Planner after it. */
    private fun styleButton() {
        val b = button ?: return
        val density = resources.displayMetrics.density
        val read = readToday()
        b.text = if (read) "Planner" else "Read route"
        b.textSize = if (read) 13f else 15f
        b.setTextColor(if (read) Color.parseColor("#1F7A4D") else Color.WHITE)
        (b.background as? GradientDrawable)?.apply {
            setColor(Color.parseColor(if (read) "#FFFFFF" else "#1F7A4D"))
            setStroke((2 * density).toInt(), if (read) Color.parseColor("#1F7A4D") else Color.WHITE)
        }
        val pad = ((if (read) 7 else 12) * density).toInt()
        b.setPadding(pad + pad / 2, pad, pad + pad / 2, pad)
    }

    private fun showButton() {
        if (panel != null) return
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val density = resources.displayMetrics.density
        val view = pill("Read route", true, 15f)
        val menuRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; visibility = View.GONE }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(menuRow)
            addView(view)
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = (12 * density).toInt()
            y = (resources.displayMetrics.heightPixels * 0.62).toInt()
        }
        // a touch anywhere else closes the menu
        row.setOnTouchListener { _, e -> if (e.action == MotionEvent.ACTION_OUTSIDE) closeMenu(); false }
        // drag it out of the way; a tap reads the route (or opens the planner); a long press opens the menu
        var downY = 0f
        var startY = 0
        var moved = false
        var longPressed = false
        val longPress = Runnable { longPressed = true; openMenu() }
        view.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    downY = e.rawY; startY = lp.y; moved = false; longPressed = false
                    main.postDelayed(longPress, 650)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = e.rawY - downY
                    if (abs(dy) > 12 * density) { moved = true; main.removeCallbacks(longPress) }
                    if (moved) { lp.y = (startY + dy).toInt().coerceAtLeast(0); wm.updateViewLayout(row, lp) }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longPress)
                    if (!moved && !longPressed && e.action == MotionEvent.ACTION_UP) {
                        if (menuRow.visibility == View.VISIBLE) closeMenu()
                        else if (readToday() && !busy) openPlanner() else readRoute()
                    }
                    true
                }
                else -> false
            }
        }
        wm.addView(row, lp)
        panel = row
        button = view
        menu = menuRow
        params = lp
        styleButton()
    }

    private fun openMenu() {
        val m = menu ?: return
        if (busy) return
        val density = resources.displayMetrics.density
        m.removeAllViews()
        fun item(label: String, act: () -> Unit) = m.addView(pill(label, false, 13f).apply {
            setOnClickListener { closeMenu(); act() }
            (layoutParams as? LinearLayout.LayoutParams)?.marginEnd = (6 * density).toInt()
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginEnd = (6 * density).toInt() })
        if (readToday()) item("Read again") { readRoute() }
        item("Hide today") {
            prefs.edit().putString(KEY_HIDDEN_DAY, today()).apply()
            Toast.makeText(this, "Hidden until tomorrow. Open Route Reader to bring it back.", Toast.LENGTH_LONG).show()
        }
        item("Hide for now") {
            hiddenFor = current
            updateVisibility()
            Toast.makeText(this, "Hidden. It comes back when you open this app again.", Toast.LENGTH_LONG).show()
        }
        m.visibility = View.VISIBLE
        main.removeCallbacks(closeLater)
        main.postDelayed(closeLater, 6000)
    }

    private val closeLater = Runnable { closeMenu() }
    private fun closeMenu() = main.post { menu?.visibility = View.GONE }

    private fun openPlanner() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PLANNER_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun say(text: String) = main.post { button?.text = text }

    private fun setButtonVisible(visible: Boolean) {
        val latch = CountDownLatch(1)
        main.post { panel?.visibility = if (visible) View.VISIBLE else View.INVISIBLE; latch.countDown() }
        latch.await(1, TimeUnit.SECONDS)
    }

    /* ------------------------------------------------------------ reading */

    private fun readRoute() {
        if (busy) return
        busy = true
        main.post {
            // reading: the full green button, whatever it showed
            button?.let { it.text = "Read route"; it.textSize = 15f }
        }
        Thread {
            try {
                val result = Reader(this).read { msg -> say(msg) }
                if (result == null) {
                    say("Nothing to read")
                    main.postDelayed({ styleButton() }, 3000)
                    return@Thread
                }
                say("Sending…")
                val id = Handoff.send(BuildConfig.PLANNER_URL, result)
                // the first read that reached the planner names the job list app: the button shows over it only
                if (prefs.getString(KEY_APP, null) == null) prefs.edit().putString(KEY_APP, result.app).apply()
                // today's route is in the planner: from now on today, the button opens it
                prefs.edit().putString(KEY_READ_DAY, today()).apply()
                val url = "${BuildConfig.PLANNER_URL}/#handoff=$id"
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                say("Failed: ${e.message?.take(40) ?: "error"}")
                main.postDelayed({ styleButton() }, 5000)
            } finally {
                busy = false
                updateVisibility()
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
        const val PREFS = "reader"
        const val KEY_APP = "app"
        const val KEY_READ_DAY = "readDay"
        const val KEY_HIDDEN_DAY = "hiddenDay"
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
