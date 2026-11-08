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
 * SENDING A WALK'S RECORDING IN THE BACKGROUND (1.12; the owner, 2026-11-08: "Is there any way to upload in the
 * background? I believe that requires having a notification that displays during the upload."). A foreground service
 * of the data-sync kind: Android lets it run with the screen off or the app in the background as long as its
 * notification shows, which carries the progress. Android 15 allows such a service 6 hours a day; a send cut off
 * (that, no signal, the phone restarted) carries on from where it stopped when the app next opens (Recorder.kt).
 */
class UploadService : Service() {
    private var worker: Thread? = null
    private val nm get() = getSystemService(NotificationManager::class.java)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val base = intent?.getStringExtra("base")
        if (base == null) { stopSelf(); return START_NOT_STICKY }
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Sending recordings", NotificationManager.IMPORTANCE_LOW))
        val first = note("Sending a walk's recording", "Starting…", -1, true)
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, first)
        if (worker?.isAlive == true) return START_NOT_STICKY
        val rec = Recorder.of(this, base)
        worker = Thread {
            // the processor kept awake while sending, the screen off or not
            val wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lawnar:upload")
            wake.acquire(6L * 3600 * 1000)
            var ok = false
            var lastPct = -1
            try {
                ok = rec.sendPending { _, sent, total ->
                    val pct = if (total > 0) (sent * 100 / total).toInt() else 0
                    if (pct != lastPct) {
                        lastPct = pct
                        nm.notify(ID, note("Sending a walk's recording", "${sent / 1_000_000} of ${total / 1_000_000} MB", pct, true))
                    }
                }
            } finally { if (wake.isHeld) wake.release() }
            finish(ok)
        }.apply { start() }
        return START_NOT_STICKY
    }

    /** Android 15's limit for a data-sync service (6 hours a day): stop; the rest goes when the app next opens. */
    override fun onTimeout(startId: Int, fgsType: Int) { finish(false) }

    private fun finish(ok: Boolean) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        // what happened, left in the notification shade (dismissable)
        nm.notify(DONE, note(if (ok) "Recording sent" else "Recording not sent yet",
            if (ok) "On the scan site, ready to replay." else "It carries on from where it stopped when the app next opens.", -2, false))
        stopSelf()
    }

    /** pct: 0-100 a bar, -1 a bar with no end yet, -2 none. */
    private fun note(title: String, text: String, pct: Int, ongoing: Boolean): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(if (ongoing) android.R.drawable.stat_sys_upload else android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title).setContentText(text)
            .setContentIntent(open)
            .setOngoing(ongoing).setOnlyAlertOnce(true).setAutoCancel(!ongoing)
            .apply { if (pct >= -1) setProgress(100, maxOf(pct, 0), pct == -1) }
            .build()
    }

    companion object {
        const val CHANNEL = "uploads"
        const val ID = 41
        const val DONE = 42
    }
}
