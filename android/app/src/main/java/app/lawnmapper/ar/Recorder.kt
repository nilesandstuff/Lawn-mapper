package app.lawnmapper.ar

import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/**
 * A WALK'S ARCORE RECORDING, SENT AND FETCHED (bridge 3; the owner, 2026-11-08: "let's do it so I don't have to keep
 * doing the same walks over and over"). ARCore writes the walk's camera, motion and Geospatial input to an MP4 in
 * recordings/<walk>.mp4; once the walk ends it goes to the scan site in 8 MB pieces (scan/src/recording.js) with the
 * page's own sign-in cookie, and is deleted from the phone once the site has it whole. A recording not yet sent is
 * sent again when the app next opens. For a replay the MP4 is fetched back into the cache. How each goes is told to the
 * page as events: { type: "upload" | "download", walk, sent | got, total, done, error }.
 */
class Recorder(private val a: MainActivity, private val base: String) {
    val dir: File get() = File(a.filesDir, "recordings").apply { mkdirs() }
    fun fileFor(walk: String) = File(dir, "${safe(walk)}.mp4")
    fun replayFile(walk: String) = File(a.cacheDir, "replay-${safe(walk)}.mp4")
    @Volatile private var sending = false

    private fun safe(w: String) = w.replace(Regex("[^0-9a-zA-Z_-]"), "").take(40)
    private fun cookie(): String? = try { CookieManager.getInstance().getCookie(base) } catch (_: Exception) { null }

    private fun open(path: String, method: String): HttpURLConnection {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 20000; c.readTimeout = 120000
        cookie()?.let { c.setRequestProperty("Cookie", it) }
        return c
    }
    private fun readJson(c: HttpURLConnection): JSONObject {
        val code = c.responseCode
        val body = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        if (code !in 200..299) throw RuntimeException("the site answered $code ${body.take(120)}")
        return JSONObject(body)
    }

    /** Recordings on the phone not yet sent: [{ walk, bytes }]. */
    fun pending(): String = JSONArray(dir.listFiles { f -> f.name.endsWith(".mp4") }?.map { JSONObject().put("walk", it.nameWithoutExtension).put("bytes", it.length()) } ?: emptyList<JSONObject>()).toString()

    /** Send every recording waiting on the phone, one after another, off the UI thread. */
    fun sendAll() {
        if (sending) return
        sending = true
        Thread {
            try {
                for (f in dir.listFiles { x -> x.name.endsWith(".mp4") && x.length() > 0 }?.sortedBy { it.lastModified() } ?: emptyList()) send(f)
            } finally { sending = false }
        }.start()
    }

    private fun send(f: File) {
        val walk = f.nameWithoutExtension
        val total = f.length()
        try {
            val start = readJson(open("/api/scan/recording/start?walk=$walk", "POST").apply { doOutput = true; outputStream.close() })
            val upload = start.getString("upload")
            val piece = start.optLong("piece", 8L * 1024 * 1024)
            val parts = JSONArray()
            var sent = 0L
            var n = 1
            RandomAccessFile(f, "r").use { raf ->
                val buf = ByteArray(piece.toInt())
                while (sent < total) {
                    val len = minOf(piece, total - sent).toInt()
                    raf.seek(sent); raf.readFully(buf, 0, len)
                    var tries = 0
                    while (true) {
                        try {
                            val c = open("/api/scan/recording/part?walk=$walk&upload=${java.net.URLEncoder.encode(upload, "UTF-8")}&n=$n", "PUT")
                            c.doOutput = true; c.setFixedLengthStreamingMode(len)
                            c.setRequestProperty("Content-Type", "application/octet-stream")
                            c.outputStream.use { it.write(buf, 0, len) }
                            val j = readJson(c)
                            parts.put(JSONObject().put("n", n).put("etag", j.getString("etag")))
                            break
                        } catch (e: Exception) {
                            if (++tries >= 4) throw e
                            Thread.sleep(2000L * tries)
                        }
                    }
                    sent += len; n++
                    a.event(JSONObject().put("type", "upload").put("walk", walk).put("sent", sent).put("total", total).toString())
                }
            }
            val done = open("/api/scan/recording/done?walk=$walk&upload=${java.net.URLEncoder.encode(upload, "UTF-8")}", "POST")
            done.doOutput = true; done.setRequestProperty("Content-Type", "application/json")
            done.outputStream.use { it.write(JSONObject().put("parts", parts).toString().toByteArray()) }
            readJson(done)
            f.delete()   // the site has it whole: 100+ MB off the phone
            a.event(JSONObject().put("type", "upload").put("walk", walk).put("sent", total).put("total", total).put("done", true).toString())
        } catch (e: Exception) {
            a.event(JSONObject().put("type", "upload").put("walk", walk).put("total", total).put("error", e.message ?: e.javaClass.simpleName).toString())
        }
    }

    /** Fetch a walk's recording for a replay; then(file) on the UI thread, or an error event. */
    fun fetch(walk: String, then: (File) -> Unit) {
        val f = replayFile(walk)
        if (f.exists() && f.length() > 0) { a.runOnUiThread { then(f) }; return }
        Thread {
            try {
                val c = open("/api/scan/recording?walk=${safe(walk)}", "GET")
                if (c.responseCode != 200) throw RuntimeException("the site answered ${c.responseCode}")
                val total = c.contentLengthLong
                val tmp = File(f.path + ".part")
                var got = 0L
                var last = 0L
                c.inputStream.use { ins -> tmp.outputStream().use { out ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val k = ins.read(buf); if (k < 0) break
                        out.write(buf, 0, k); got += k
                        if (got - last > 4L * 1024 * 1024) { last = got; a.event(JSONObject().put("type", "download").put("walk", walk).put("got", got).put("total", total).toString()) }
                    }
                } }
                // old replays out of the cache: one at a time is plenty
                a.cacheDir.listFiles { x -> x.name.startsWith("replay-") && x.name.endsWith(".mp4") }?.forEach { it.delete() }
                tmp.renameTo(f)
                a.event(JSONObject().put("type", "download").put("walk", walk).put("got", got).put("total", total).put("done", true).toString())
                a.runOnUiThread { then(f) }
            } catch (e: Exception) {
                a.event(JSONObject().put("type", "error").put("message", "the recording could not be fetched: ${e.message ?: e.javaClass.simpleName}").toString())
            }
        }.start()
    }
}
