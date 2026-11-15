package app.lawnmapper.ar

import android.content.Intent
import android.hardware.usb.UsbManager
import android.webkit.WebView
import com.google.ar.core.Pose
import app.lawnmapper.ar.thermal.ThermalBridge
import app.lawnmapper.ar.thermal.ThermalCamera

/**
 * DEV ONLY -- THE DEV BUILD'S EXTRAS: THE USB THERMAL CAMERA (src/dev/README.md). The store build compiles
 * src/store/.../Extras.kt instead, which does nothing. MainActivity and ArEngine call these four and know nothing
 * else of the camera.
 */
object Extras {
    @Volatile private var cam: ThermalCamera? = null

    fun install(a: MainActivity, web: WebView, base: String) {
        val c = ThermalCamera(a.applicationContext, base)
        cam = c
        web.addJavascriptInterface(ThermalBridge(c), "LawnARThermal")
        // a camera already plugged in when the app opens; a thermal file an earlier walk could not send
        web.postDelayed({ c.connect(); c.uploads.sendAll() }, 1500)
    }

    /** The app opened (or brought forward) by Android because the camera was plugged in. */
    fun intent(a: MainActivity, intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) cam?.connect()
    }

    fun arFrame(timestampNs: Long, pose: Pose?, tracking: Boolean) { cam?.arFrame(timestampNs, pose, tracking) }

    fun destroy() { cam?.close(); cam = null }
}
