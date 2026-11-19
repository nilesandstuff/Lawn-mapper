package app.routereader

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The app's one screen: whether the reader is on, the buttons to the two
 * settings it needs, and how to use it. Everything else happens from the
 * Read route button over the job list app.
 */
class MainActivity : Activity() {

    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val d = resources.displayMetrics.density
        val pad = (20 * d).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
        }
        fun text(s: String, size: Float = 16f, bold: Boolean = false) = TextView(this).apply {
            text = s
            textSize = size
            setTextColor(Color.parseColor("#17201C"))
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setPadding(0, (8 * d).toInt(), 0, (8 * d).toInt())
        }
        fun button(s: String, go: () -> Unit) = Button(this).apply { text = s; isAllCaps = false; textSize = 16f; setOnClickListener { go() } }

        col.addView(text("Route Reader", 26f, true))
        status = text("", 17f, true)
        col.addView(status)
        col.addView(button("1. Turn on Route Reader") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
        col.addView(text("Find Route Reader in the list (it may be under Installed apps or Downloaded apps), open it, and switch it on.", 14f))
        col.addView(button("If it is greyed out: allow restricted settings") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        })
        col.addView(text("On the App info screen, tap the three dots at the top right, then Allow restricted settings. Then come back and do step 1 again.", 14f))
        col.addView(text("How to use it", 20f, true))
        col.addView(text("1. Open the app with today's jobs, on the list of jobs.\n2. Tap the green Read route button.\n3. Wait: it scrolls to the top, then down to the bottom, reading as it goes. Don't touch the screen.\n4. The route planner opens with the stops. Check them, then plan.\n\nDrag the button up or down if it is in the way.", 15f))
        col.addView(button("Open the route planner") { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PLANNER_URL))) })
        col.addView(text("Version ${BuildConfig.VERSION_NAME}", 12f))
        setContentView(ScrollView(this).apply { setBackgroundColor(Color.parseColor("#F4F6F5")); addView(col) })
    }

    override fun onResume() {
        super.onResume()
        val on = isOn()
        status.text = if (on) "Route Reader is ON. Look for the green Read route button." else "Route Reader is OFF. Turn it on below."
        status.setTextColor(Color.parseColor(if (on) "#1F7A4D" else "#B3261E"))
        status.gravity = Gravity.START
    }

    private fun isOn(): Boolean {
        val me = ComponentName(this, ReaderService::class.java).flattenToString()
        val list = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return list.split(':').any { it.equals(me, ignoreCase = true) }
    }
}
