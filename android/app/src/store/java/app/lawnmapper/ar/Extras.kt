package app.lawnmapper.ar

import android.content.Intent
import android.webkit.WebView
import com.google.ar.core.Pose

/**
 * THE STORE BUILD'S EXTRAS: NONE. The "dev" build has a file of the same name (src/dev/.../Extras.kt) that adds the
 * USB thermal camera; this one is what a build for the Play Store compiles instead, so nothing of the thermal camera
 * can reach it. MainActivity and ArEngine call these five and know nothing else.
 */
object Extras {
    fun install(a: MainActivity, web: WebView, base: String) {}
    fun intent(a: MainActivity, intent: Intent?) {}
    fun arFrame(timestampNs: Long, pose: Pose?, tracking: Boolean) {}
    fun readings(w: WebView) {}
    fun destroy() {}
}
