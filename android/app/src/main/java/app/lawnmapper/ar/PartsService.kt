package app.lawnmapper.ar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * A WALK'S PARTS SENT IN THE BACKGROUND (bridge 8, Parts.kt; before it, bridge 6, this only kept the PAGE awake to
 * send them, and with the app left the notification showed while "the numbers don't move": the owner, 2026-11-25).
 * A foreground service of the data-sync kind, as UploadService is for the recording: its own thread sends what
 * Parts holds, the notification says how much is left, and it ends when nothing is. Android 15 allows such a service
 * 6 hours a day; what is left then, or with no signal, goes when the app next opens.
 */
class PartsService : Service() {
    private var worker: Thread? = null
    private val nm get() = getSystemService(NotificationManager::class.java)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        nm.createNotificationChannel(NotificationChannel(UploadService.CHANNEL, "Sending recordings", NotificationManager.IMPORTANCE_LOW))
        val first = note("Sending a walk's points and pictures", "Starting…")
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, first)
        val base = intent?.getStringExtra("base")
        val parts = if (base != null) Parts.of(this, base) else Parts.existing()
        if (parts == null) { finish(); return START_NOT_STICKY }
        if (worker?.isAlive == true) return START_NOT_STICKY
        worker = Thread {
            val wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lawnar:parts")
            wake.acquire(6L * 3600 * 1000)
            var last = 0L
            try {
                // a part handed over just as the last round ended starts another
                do {
                    parts.sendAll { n, bytes ->
                        val now = System.currentTimeMillis()
                        if (now - last > 1000) { last = now; nm.notify(ID, note("Sending a walk's points and pictures", "$n part${if (n == 1) "" else "s"} left (${String.format("%.1f", bytes / 1e6)} MB)")) }
                    }
                } while (parts.pending() > 0 && parts.off == null && parts.lastError == null)
            } finally { if (wake.isHeld) wake.release() }
            finish()
        }.apply { start() }
        return START_NOT_STICKY
    }

    /** Android 15's limit for a data-sync service: stop; the parts wait on the phone for the next open. */
    override fun onTimeout(startId: Int, fgsType: Int) { finish() }

    private fun finish() { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }

    private fun note(title: String, text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, UploadService.CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title).setContentText(text)
            .setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true)
            .build()
    }

    companion object { const val ID = 43 }
}
