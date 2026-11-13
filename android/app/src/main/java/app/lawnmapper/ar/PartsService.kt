package app.lawnmapper.ar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * A WALK'S PARTS SENT WITH THE SCREEN OFF (bridge 6; the owner, 2026-11-12: "that 12 minute hang in the upload was
 * because my screen was off, maybe. I opened the app back up and it appeared to resume"). The walk's points, track
 * and pictures are sent by the PAGE (scan/lib/outbox.js), and Android pauses a page whose screen is off or whose
 * app is in the background; only the recording had a background sender (UploadService). This sends nothing itself:
 * while the page says parts are waiting (Bridge.partsPending), it is a foreground service of the data-sync kind with
 * a notification and a wake lock, which keeps the app's process and its page running, and MainActivity leaves the
 * page unpaused. When the page says none are left it stops. If Android stops it (the 6 hours a day of such a
 * service), or the app is swiped away, the parts stay on the phone and go when the app next opens, as before.
 */
class PartsService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private val nm get() = getSystemService(NotificationManager::class.java)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = intent?.getIntExtra("n", 0) ?: 0
        val mb = intent?.getDoubleExtra("mb", 0.0) ?: 0.0
        nm.createNotificationChannel(NotificationChannel(UploadService.CHANNEL, "Sending recordings", NotificationManager.IMPORTANCE_LOW))
        val text = if (n > 0) "$n part${if (n == 1) "" else "s"} left (${String.format("%.1f", mb)} MB)" else "Finishing…"
        val note = note("Sending a walk's points and pictures", text)
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, note)
        if (n <= 0) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        if (wake == null) wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lawnar:parts").apply { acquire(2L * 3600 * 1000) }
        return START_NOT_STICKY
    }

    /** Android 15's limit for a data-sync service: stop; the page's parts wait on the phone for the next open. */
    override fun onTimeout(startId: Int, fgsType: Int) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }

    override fun onDestroy() {
        try { if (wake?.isHeld == true) wake?.release() } catch (e: Exception) { /* already let go */ }
        wake = null
        super.onDestroy()
    }

    private fun note(title: String, text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, UploadService.CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title).setContentText(text)
            .setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        const val ID = 43
        @Volatile private var running = false

        /** The page's count of waiting parts: above zero keeps (or starts) the service, zero ends it. Never throws. */
        fun update(ctx: Context, n: Int, mb: Double) {
            try {
                if (n <= 0 && !running) return
                val i = Intent(ctx, PartsService::class.java).putExtra("n", n).putExtra("mb", mb)
                // from the background Android refuses a new foreground service; one already running takes the update
                if (running) ctx.startService(i) else ctx.startForegroundService(i)
                running = n > 0
            } catch (e: Exception) { android.util.Log.w("LawnAR", "parts service: ${e.message}") }
        }
    }
}
