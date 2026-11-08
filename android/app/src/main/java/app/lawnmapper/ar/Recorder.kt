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
    @Volatile private var sending = false

    /* KEEPING RECORDINGS ON THE PHONE (bridge 4; the owner, 2026-11-08: "I don't want to have to download every time
       to replay it"): with keep on (the default), a recording stays in recordings/ once the site has it, marked sent
       (<walk>.sent), and a recording fetched for a replay is kept there too; a replay uses the phone's copy when there
       is one. Each can be removed from the phone by hand; the site's copy stays. */
    private val prefs get() = a.getSharedPreferences("recordings", android.content.Context.MODE_PRIVATE)
    var keep: Boolean
        get() = prefs.getBoolean("keep", true)
        set(v) { prefs.edit().putBoolean("keep", v).apply() }
    private fun sentMark(f: File) = File(f.parentFile, f.nameWithoutExtension + ".sent")
    /** The phone's copy of a walk's recording, sent or not, or the file a replay fetches into. */
    fun replayFile(walk: String) = fileFor(walk)

    /** Every recording on the phone: [{ walk, bytes, sent }]. */
    fun local(): String = JSONArray(dir.listFiles { f -> f.name.endsWith(".mp4") }?.sortedByDescending { it.lastModified() }?.map { f ->
        JSONObject().put("walk", f.nameWithoutExtension).put("bytes", f.length()).put("sent", sentMark(f).exists())
    } ?: emptyList<JSONObject>()).toString()

    fun isSent(walk: String) = sentMark(fileFor(walk)).exists()

    /** Off the phone (the site keeps its copy); a recording not yet sent is lost with it. */
    fun remove(walk: String): Boolean {
        val f = fileFor(walk)
        val ok = !f.exists() || f.delete()
        sentMark(f).delete(); sideOf(f).delete(); File(f.path + ".part").delete()
        return ok
    }

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
    fun pending(): String = JSONArray(dir.listFiles { f -> f.name.endsWith(".mp4") && !sentMark(f).exists() }?.map { f ->
        val k = try { JSONObject(sideOf(f).readText()) } catch (_: Exception) { null }
        JSONObject().put("walk", f.nameWithoutExtension).put("bytes", f.length()).put("sent", if (k != null) minOf(f.length(), k.getJSONArray("parts").length() * k.getLong("piece")) else 0L)
    } ?: emptyList<JSONObject>()).toString()

    /** Send every recording waiting on the phone, one after another, off the UI thread. */
    fun sendAll() {
        if (sending) return
        sending = true
        Thread {
            try {
                for (f in dir.listFiles { x -> x.name.endsWith(".mp4") && x.length() > 0 && !sentMark(x).exists() }?.sortedBy { it.lastModified() } ?: emptyList()) send(f)
            } finally { sending = false }
        }.start()
    }

    /* RESUMABLE (1.10): the upload's id and the pieces the site has are kept beside the file (<walk>.json), so a send
       cut off -- no signal, the app closed -- carries on where it stopped instead of starting again (the owner's first
       recording was 2.2 GB). R2 keeps an unfinished upload for days; one it no longer knows is started afresh. */
    private fun sideOf(f: File) = File(f.parentFile, f.nameWithoutExtension + ".json")

    private fun send(f: File) {
        val walk = f.nameWithoutExtension
        val total = f.length()
        val side = sideOf(f)
        try {
            var kept = try { JSONObject(side.readText()) } catch (_: Exception) { null }
            if (kept != null && kept.optLong("bytes") != total) kept = null
            val upload: String
            val piece: Long
            val parts: JSONArray
            if (kept != null) {
                upload = kept.getString("upload"); piece = kept.getLong("piece"); parts = kept.getJSONArray("parts")
            } else {
                val start = readJson(open("/api/scan/recording/start?walk=$walk", "POST").apply { doOutput = true; outputStream.close() })
                upload = start.getString("upload"); piece = start.optLong("piece", 8L * 1024 * 1024); parts = JSONArray()
                side.writeText(JSONObject().put("upload", upload).put("piece", piece).put("bytes", total).put("parts", parts).toString())
            }
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
                            val c = open("/api/scan/recording/part?walk=$walk&upload=${java.net.URLEncoder.encode(upload, "UTF-8")}&n=$n", "PUT")
                            c.doOutput = true; c.setFixedLengthStreamingMode(len)
                            c.setRequestProperty("Content-Type", "application/octet-stream")
                            c.outputStream.use { it.write(buf, 0, len) }
                            val j = readJson(c)
                            parts.put(JSONObject().put("n", n).put("etag", j.getString("etag")))
                            side.writeText(JSONObject().put("upload", upload).put("piece", piece).put("bytes", total).put("parts", parts).toString())
                            break
                        } catch (e: Exception) {
                            // the site no longer knows this upload (expired): start afresh next time
                            if (e.message?.contains(" 404") == true || e.message?.contains("NoSuchUpload") == true) { side.delete(); throw e }
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
            side.delete()
            // the site has it whole: kept and marked sent, or off the phone, as the owner chose
            if (keep) sentMark(f).writeText("sent") else f.delete()
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
                tmp.renameTo(f)
                sentMark(f).writeText("sent")   // the site's copy: never sent back (with keep off, removed when the replay ends)
                a.event(JSONObject().put("type", "download").put("walk", walk).put("got", got).put("total", total).put("done", true).toString())
                a.runOnUiThread { then(f) }
            } catch (e: Exception) {
                a.event(JSONObject().put("type", "error").put("message", "the recording could not be fetched: ${e.message ?: e.javaClass.simpleName}").toString())
            }
        }.start()
    }
}
