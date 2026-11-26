package app.lawnmapper.ar

import android.content.Context
import android.content.Intent
import android.util.Base64
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * A WALK'S PARTS, KEPT AND SENT BY THE APP (bridge 8; the owner, 2026-11-25: with the app left after a walk the
 * notification showed "but the numbers don't move. The full recordings have historically sent fine in the background,
 * so yea it sounds like doing the walk upload data the same way would be good. Build it."). Until now the PAGE sent a
 * walk's points, track and pictures (scan/lib/outbox.js) and the app only kept the page awake (bridge 6), which did
 * not keep it sending. Now the page hands each part over as it is made (Bridge.keepPart) and the app owns it: kept in
 * parts/ as <id>.bin with <id>.json ({ path, type, n }), sent by PartsService with the page's sign-in cookie, four at
 * a time (a send's wait is the round trip, not its bytes), and deleted once the site has it. A part handed over again
 * under the same path (live.json, rewritten every few seconds) replaces the older copy; only the copy that went is
 * deleted. What cannot go (no signal, signed out) waits and goes when the app next opens.
 */
class Parts private constructor(ctx: Context, val base: String) {
    companion object {
        @Volatile private var one: Parts? = null
        fun of(ctx: Context, base: String): Parts = one ?: synchronized(this) { one ?: Parts(ctx, base).also { one = it } }
        fun existing(): Parts? = one
        const val PARALLEL = 4
    }
    private val app: Context = ctx.applicationContext
    private val lock = Any()
    private var seq = System.currentTimeMillis()
    val dir: File get() = File(app.filesDir, "parts").apply { mkdirs() }
    @Volatile private var running = false
    @Volatile var sent = 0
    @Volatile var sentBytes = 0L
    @Volatile var dropped = 0
    @Volatile var lastError: String? = null
    @Volatile var off: String? = null

    private fun idOf(path: String) = MessageDigest.getInstance("SHA-1").digest(path.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun metas() = dir.listFiles { f -> f.name.endsWith(".json") }?.filter { File(dir, it.nameWithoutExtension + ".bin").exists() } ?: emptyList()

    /* THE LIST IN MEMORY (2026-11-26; the walk of 4:21 pm Thu Eastern: 15.9 stalls a minute while parts were handed
       over, none while not). Every status the page asked for, and every hand-over's kick, listed the whole folder and
       looked at each file, while the page waited on the answer: a cost that grew with what waited. Now the folder is
       read once, and the list (id -> [n, bytes]) kept here, under the lock, as parts come and go. */
    private var index: HashMap<String, LongArray>? = null
    private fun idx(): HashMap<String, LongArray> {
        index?.let { return it }
        val m = HashMap<String, LongArray>()
        for (f in metas()) {
            val n = try { JSONObject(f.readText()).optLong("n") } catch (_: Exception) { 0L }
            m[f.nameWithoutExtension] = longArrayOf(n, File(dir, f.nameWithoutExtension + ".bin").length())
        }
        index = m
        return m
    }

    /** Keep one part (the page's hand-over). path: the scan site's own route for it, with its query. */
    fun keep(path: String, type: String, b64: String): Boolean {
        if (!path.startsWith("/api/scan/")) return false
        var ok = false
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val id = idOf(path)
            synchronized(lock) {
                val tmp = File(dir, "$id.tmp")
                tmp.writeBytes(bytes)
                File(dir, "$id.json").writeText(JSONObject().put("path", path).put("type", type).put("n", seq++).toString())
                val bin = File(dir, "$id.bin")
                val n = seq - 1
                ok = tmp.renameTo(bin)
                if (!ok) { bin.delete(); ok = tmp.renameTo(bin) }
                if (ok) idx()[id] = longArrayOf(n, bytes.size.toLong()) else idx().remove(id)
            }
        } catch (e: Exception) { lastError = e.message ?: e.javaClass.simpleName; ok = false }
        if (ok) { off = null; kick() }
        return ok
    }

    /** { pending, bytes, sent, sentBytes, dropped, sending, lastError, off } for the page's upload box. */
    fun status(): String {
        val (count, bytes) = synchronized(lock) { val m = idx(); Pair(m.size, m.values.sumOf { it[1] }) }
        return JSONObject().put("pending", count).put("bytes", bytes).put("sent", sent).put("sentBytes", sentBytes)
            .put("dropped", dropped).put("sending", running).put("lastError", lastError ?: JSONObject.NULL).put("off", off ?: JSONObject.NULL).toString()
    }
    fun pending(): Int = synchronized(lock) { idx().size }
    fun pendingBytes(): Long = synchronized(lock) { idx().values.sumOf { it[1] } }

    /** Send what waits: PartsService does it, with its notification; if Android will not start one now, a plain thread. */
    fun kick() {
        if (running || pending() == 0) return
        try { app.startForegroundService(Intent(app, PartsService::class.java).putExtra("base", base)) }
        catch (e: Exception) { Thread { sendAll { _, _ -> } }.start() }
    }

    private fun sendOne(meta: File): String {
        val id = meta.nameWithoutExtension
        // read under the lock: [path, type, n] and the body, or null when the part is unreadable (dropped) or busy
        var path = ""; var type = "application/octet-stream"; var n = 0L
        var body: ByteArray? = null
        var broken = false
        synchronized(lock) {
            try {
                val j = JSONObject(meta.readText())
                path = j.getString("path"); type = j.optString("type", type); n = j.optLong("n")
                body = File(dir, "$id.bin").readBytes()
            } catch (_: Exception) { broken = true }
        }
        val bytes = body
        if (broken || bytes == null) {
            synchronized(lock) { meta.delete(); File(dir, "$id.bin").delete(); idx().remove(id) }
            dropped++; return "drop"
        }
        var code = 0
        var why = ""
        try {
            val c = URL(base + path).openConnection() as HttpURLConnection
            c.requestMethod = "PUT"; c.connectTimeout = 20000; c.readTimeout = 60000
            val cookie = try { CookieManager.getInstance().getCookie(base) } catch (_: Exception) { null }
            if (cookie != null) c.setRequestProperty("Cookie", cookie)
            c.setRequestProperty("Content-Type", type)
            c.doOutput = true; c.setFixedLengthStreamingMode(bytes.size)
            c.outputStream.use { it.write(bytes) }
            code = c.responseCode
            if (code !in 200..299) why = try { c.errorStream?.bufferedReader()?.readText()?.take(80) ?: "" } catch (_: Exception) { "" }
            c.disconnect()
        } catch (e: Exception) { lastError = e.message ?: "no connection"; return "retry" }
        // the same answers the page gave (scan/public/app.js sendPartNow)
        if (code == 503) { off = "the site has no twin bucket yet"; return "off" }
        if (code in 200..299 || !(code == 408 || code == 429 || code >= 500 || code == 401 || code == 403 || code == 404)) {
            synchronized(lock) {
                // only the copy that went is taken off the phone (a newer one may have been handed over meanwhile)
                val now = try { JSONObject(meta.readText()).optLong("n") } catch (_: Exception) { n }
                if (now == n) { meta.delete(); File(dir, "$id.bin").delete(); idx().remove(id) }
            }
            if (code in 200..299) { sent++; sentBytes += bytes.size; lastError = null; return "ok" }
            dropped++; lastError = "refused $code $why"; return "drop"
        }
        lastError = if (code == 401 || code == 403) "signed out for now" else "the site answered $code"
        return "retry"
    }

    /** Everything that waits, oldest first, PARALLEL at a time, on the caller's thread; progress(parts left, bytes
     *  left). True when nothing is left. Gives up after a run of failed rounds (the rest goes at the next open). */
    fun sendAll(progress: (Int, Long) -> Unit): Boolean {
        synchronized(this) { if (running) return true; running = true }
        val pool = Executors.newFixedThreadPool(PARALLEL)
        try {
            var failedRounds = 0
            var backoff = 0L
            while (true) {
                val all = synchronized(lock) { idx().entries.sortedBy { it.value[0] }.map { File(dir, it.key + ".json") } }
                if (all.isEmpty()) return true
                progress(all.size, pendingBytes())
                var failed = false
                var i = 0
                while (i < all.size && !failed && off == null) {
                    val rs = pool.invokeAll(all.subList(i, minOf(all.size, i + PARALLEL)).map { m -> Callable { sendOne(m) } }).map { try { it.get() } catch (_: Exception) { "retry" } }
                    if (rs.any { it == "retry" }) failed = true
                    i += PARALLEL
                    progress(pending(), pendingBytes())
                }
                if (off != null) return false
                if (!failed) { failedRounds = 0; backoff = 0; continue }
                if (++failedRounds >= 10) return false
                backoff = if (backoff == 0L) 5000 else minOf(60000, backoff * 2)
                Thread.sleep(backoff)
            }
        } catch (e: Exception) { lastError = e.message ?: e.javaClass.simpleName; return false }
        finally { pool.shutdownNow(); running = false }
    }
}
