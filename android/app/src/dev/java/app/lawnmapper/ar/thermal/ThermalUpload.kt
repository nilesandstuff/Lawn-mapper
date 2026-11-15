package app.lawnmapper.ar.thermal

import android.content.Context
import android.os.PowerManager
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * DEV ONLY -- A WALK'S THERMAL FILE, SENT (src/dev/README.md). The way a walk's ARCore recording goes (Recorder.kt):
 * in 8 MB pieces to the scan site's /api/scan/recording routes with &file=thermal, the page's own sign-in cookie, into
 * the walk's twin in the private bucket as twins/<walk>/thermal.bin; resumable (the upload's id and the pieces the
 * site has are kept beside the file); taken off the phone once the site has it whole. A file left by a walk that was
 * cut short, or not yet sent, goes when the app next opens.
 */
class ThermalUpload(private val app: Context, private val base: String, val dir: File) {
    @Volatile private var sending = false
    @Volatile private var now: JSONObject? = null
    @Volatile private var error: String? = null
    /** The file a walk is still writing: not sent. */
    @Volatile var writing: String? = null

    private fun waiting(): List<File> = dir.listFiles { f -> f.name.endsWith(".bin") && f.length() > 5 && f.nameWithoutExtension != writing }?.sortedBy { it.lastModified() } ?: emptyList()
    private fun sideOf(f: File) = File(f.parentFile, f.nameWithoutExtension + ".json")

    fun status(): JSONObject {
        val w = waiting()
        return JSONObject().put("waiting", w.size).put("bytes", w.sumOf { it.length() }).put("sending", now ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL)
    }

    fun sendAll() {
        synchronized(this) { if (sending || waiting().isEmpty()) return; sending = true }
        Thread {
            val wake = (app.getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lawnar:thermal")
            try {
                wake.acquire(3600 * 1000L)
                for (f in waiting()) {
                    try { send(f); error = null } catch (e: Exception) { error = e.message ?: e.javaClass.simpleName; break }
                }
            } finally {
                now = null; sending = false
                try { if (wake.isHeld) wake.release() } catch (_: Exception) {}
            }
        }.apply { name = "thermal-upload"; start() }
    }

    private fun open(path: String, method: String): HttpURLConnection {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 20000; c.readTimeout = 120000
        val cookie: String? = try { CookieManager.getInstance().getCookie(base) } catch (_: Exception) { null }
        if (cookie != null) c.setRequestProperty("Cookie", cookie)
        return c
    }
    private fun readJson(c: HttpURLConnection): JSONObject {
        val code = c.responseCode
        val body = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        if (code !in 200..299) throw RuntimeException("the site answered $code ${body.take(120)}")
        return JSONObject(body)
    }

    private fun send(f: File) {
        val walk = f.nameWithoutExtension
        val total = f.length()
        val side = sideOf(f)
        val q = "walk=$walk&file=thermal"
        var kept = try { JSONObject(side.readText()) } catch (_: Exception) { null }
        if (kept != null && kept.optLong("bytes") != total) kept = null
        val upload: String; val piece: Long; val parts: JSONArray
        if (kept != null) { upload = kept.getString("upload"); piece = kept.getLong("piece"); parts = kept.getJSONArray("parts") } else {
            val start = readJson(open("/api/scan/recording/start?$q", "POST").apply { doOutput = true; outputStream.close() })
            upload = start.getString("upload"); piece = start.optLong("piece", 8L * 1024 * 1024); parts = JSONArray()
        }
        val keep = { side.writeText(JSONObject().put("upload", upload).put("piece", piece).put("bytes", total).put("parts", parts).toString()) }
        keep()
        val up = URLEncoder.encode(upload, "UTF-8")
        var n = parts.length() + 1
        var sent = minOf(total, parts.length() * piece)
        RandomAccessFile(f, "r").use { raf ->
            val buf = ByteArray(piece.toInt())
            while (sent < total) {
                val len = minOf(piece, total - sent).toInt()
                raf.seek(sent); raf.readFully(buf, 0, len)
                var tries = 0
                while (true) {
                    try {
                        val c = open("/api/scan/recording/part?$q&upload=$up&n=$n", "PUT")
                        c.doOutput = true; c.setFixedLengthStreamingMode(len)
                        c.setRequestProperty("Content-Type", "application/octet-stream")
                        c.outputStream.use { it.write(buf, 0, len) }
                        val j = readJson(c)
                        parts.put(JSONObject().put("n", n).put("etag", j.getString("etag")))
                        keep()
                        break
                    } catch (e: Exception) {
                        // the site no longer knows this upload (expired): started afresh next time
                        if (e.message?.contains(" 404") == true) { side.delete(); throw e }
                        if (++tries >= 4) throw e
                        Thread.sleep(2000L * tries)
                    }
                }
                sent += len; n++
                now = JSONObject().put("walk", walk).put("sent", sent).put("total", total)
            }
        }
        val done = open("/api/scan/recording/done?$q&upload=$up", "POST")
        done.doOutput = true; done.setRequestProperty("Content-Type", "application/json")
        done.outputStream.use { it.write(JSONObject().put("parts", parts).toString().toByteArray()) }
        readJson(done)
        side.delete(); f.delete()
    }
}
