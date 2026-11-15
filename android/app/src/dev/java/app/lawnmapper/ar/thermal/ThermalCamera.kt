package app.lawnmapper.ar.thermal

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.google.ar.core.Pose
import app.lawnmapper.ar.BuildConfig
import app.lawnmapper.thermalprobe.Uvc
import app.lawnmapper.thermalprobe.UvcFrameData
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * DEV ONLY -- THE USB THERMAL CAMERA DURING A WALK (core session, 2026-11-15; src/dev/README.md). Not in the store
 * build: this whole folder belongs to the "dev" flavour.
 *
 * What the camera needs is the thermal session's, ported from its probe (thermal-probe/ on its branch, MainActivity
 * open / setNormalRangeWork / vbAdjust / flatFieldNow) step for step and number for number; nothing here was guessed.
 * Uvc.kt beside this is the probe's own file, unchanged.
 *
 *   connect: claim, read the controls, start the stream, bind, download the calibration tables, then -- unless the
 *     camera is already in the state the vendor's app leaves (row 216 words 3/4/10 = 42/7/209) -- the 19 range
 *     registers, the dark-level loop and 30 s to settle; then a shutter reference.
 *   a shutter reference: close, 400 ms, the dark-level loop, 16 frames, open (each move released after 200 ms, inside
 *     Uvc.shutterControl). Every 30 s for the first 3 minutes after the camera connects, then every 45 s.
 *   kept while a walk records (ThermalFile; the thermal session's answers of 2026-11-15): 2 frames a second while
 *     walking, and every frame (25 a second) only for a reference's 16 frames, a sky shot (2 s) and a timing sweep
 *     (5 s); each with its time (elapsedRealtimeNanos) and the number of the reference before it. Of each frame, rows
 *     0-216 and columns 0-259 (the picture, the blind reference rows and the metadata row), the same crop for every
 *     kind of frame; never binned, never averaged. Packed without loss as differences from the latest reference's
 *     first frame.
 *   ARCore's raw camera pose (Camera.getPose(), the physical camera) at every ARCore frame, with ARCore's own
 *     timestamp and this clock read beside it, so the two clocks line up all the way through the walk.
 *
 * Nothing is converted to a temperature here: that needs the vendor-derived conversion, which lives only in the
 * owner's private repository. The calibration tables carry the camera's serial number: they stay in the app's
 * private storage and are never written to a log.
 */
class ThermalCamera(private val app: Context, private val base: String) {
    companion object {
        const val VENDOR = 0x38BE
        const val PRODUCT = 0x0184
        const val ACTION_USB = "app.lawnmapper.ar.THERMAL_USB_PERMISSION"
        const val ROWS = 222
        const val KEEP_ROWS = 217           // rows 0-216: the picture, the blind reference rows, the metadata row
        const val KEEP_COLS = 260           // columns 0-259
        const val REFERENCE_EVERY_MS = 45_000L
        const val REFERENCE_EARLY_MS = 30_000L      // while the camera is still warming:
        const val EARLY_FOR_MS = 180_000L           // the first 3 minutes after it connects
        const val REFERENCE_FRAMES = 16
        const val KEEP_EVERY = 12           // of 25 frames a second: about 2 kept
        const val SKY_WITHIN_DEG = 20.0     // a sky shot: the phone camera within this of straight up
        const val SKY_MS = 2000L
        const val SWEEP_MS = 5000L
        // frame types in the file
        const val SCENE = 0; const val REFERENCE = 1; const val SKY = 2; const val SWEEP = 3; const val SHUTTER = 4
    }

    private val usb = app.getSystemService(Context.USB_SERVICE) as UsbManager
    private val work = Executors.newSingleThreadExecutor { r -> Thread(r, "thermal-work") }
    private val main = Handler(Looper.getMainLooper())
    val dir: File get() = File(app.filesDir, "thermal").apply { mkdirs() }
    private val tables: File get() = File(dir, "tables").apply { mkdirs() }
    val uploads = ThermalUpload(app, base, File(dir, "walks").apply { mkdirs() })

    // what the page is told (status())
    @Volatile private var state = "none"      // none | asking | setup | settling | ready | failed | unplugged
    @Volatile private var detail = ""
    @Volatile private var secs = 0
    @Volatile private var busy: String? = null   // reference | sky | sweep
    @Volatile private var setup = ""             // vendor | own

    @Volatile private var uvc: Uvc? = null
    private var device: UsbDevice? = null
    @Volatile private var width = 264
    @Volatile private var lastRow216: IntArray? = null
    @Volatile private var rangeSet = false
    private val notes = StringBuilder()          // the setup's own log, in memory only (never the tables' bytes)
    private fun note(s: String) { synchronized(notes) { if (notes.length < 200_000) notes.append(s).append('\n') } }

    // frames
    @Volatile private var seen = 0L
    @Volatile private var seq = 0
    @Volatile private var refIndex = 0
    @Volatile private var refLeft = 0
    @Volatile private var shutterBusy = false
    @Volatile private var skyUntil = 0L          // every frame kept until this time (elapsedRealtimeNanos)
    @Volatile private var sweepUntil = 0L
    @Volatile private var lastRefAt = 0L         // elapsedRealtime ms
    @Volatile private var fps = 0.0
    private val times = ArrayDeque<Long>()
    @Volatile private var connectedAt = 0L       // elapsedRealtime ms
    /** The latest reference's first frame (cropped) and its sequence number: what later frames are packed against. */
    @Volatile private var baseFrame: ByteArray? = null
    @Volatile private var baseSeq = 0
    @Volatile private var wantBase = false
    @Volatile private var upDeg = Double.NaN     // the phone camera's angle from straight up, from ARCore

    // the walk being recorded
    @Volatile private var file: ThermalFile? = null
    @Volatile private var walk: String? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                ACTION_USB -> {
                    val granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) device?.let { open(it) } else set("failed", "USB access was refused. Tap Connect to ask again.")
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> if (uvc != null) unplugged()
            }
        }
    }

    init {
        val filter = IntentFilter().apply { addAction(ACTION_USB); addAction(UsbManager.ACTION_USB_DEVICE_DETACHED) }
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else app.registerReceiver(receiver, filter)
    }

    fun close() {
        try { app.unregisterReceiver(receiver) } catch (_: Exception) {}
        main.removeCallbacksAndMessages(null)
        endWalk()
        val u = uvc; uvc = null
        if (u != null) work.execute { try { u.release() } catch (_: Exception) {} }
    }

    private fun set(s: String, d: String = "", sec: Int = 0) { state = s; detail = d; secs = sec }

    // ---------------- connecting (the probe's connect / open) ----------------

    private fun find(): UsbDevice? = usb.deviceList.values.firstOrNull { it.vendorId == VENDOR && it.productId == PRODUCT }

    fun present(): Boolean = find() != null

    fun connect() {
        if (uvc != null) return
        val d = find() ?: run { set("none"); return }
        device = d
        if (usb.hasPermission(d)) { open(d); return }
        val pi = PendingIntent.getBroadcast(app, 0, Intent(ACTION_USB).setPackage(app.packageName), PendingIntent.FLAG_MUTABLE)
        set("asking", "Asking for USB access: tap Allow.")
        usb.requestPermission(d, pi)
    }

    private fun open(d: UsbDevice) {
        if (uvc != null) return
        val conn = usb.openDevice(d) ?: run { set("failed", "Android would not open the camera."); return }
        // the probe's own log quotes descriptors and replies in hex: not kept (only this file's notes are)
        val u = Uvc(d, conn) { }
        uvc = u
        connectedAt = SystemClock.elapsedRealtime()
        synchronized(notes) { notes.setLength(0) }
        set("setup", "starting")
        work.execute {
            try {
                u.claimAll()
                try { u.readAllControls() } catch (e: Exception) { note("control read failed: $e") }
                val f = u.desc.formats.firstOrNull()
                val fr = f?.frames?.firstOrNull()
                if (f == null || fr == null) { set("failed", "The camera listed no video format."); return@execute }
                u.stop()
                if (!u.commit(f.index, fr.frameIndex, fr.defaultInterval)) { set("failed", "The camera refused its video format."); return@execute }
                width = fr.width
                u.start(::onFrame)
                Thread.sleep(500)
                set("setup", "binding")
                note(try { u.bindSequence() } catch (e: Exception) { "bind failed: $e" })
                set("setup", "reading the camera's calibration tables")
                readTables(u)
                // the vendor's app has just used the camera: its full sensor setup is still in place; left alone
                val w = lastRow216
                val vendorState = w != null && w[3] == 42 && w[4] == 7 && w[10] == 209
                val ok: Boolean
                if (vendorState) { ok = true; setup = "vendor" } else {
                    set("setup", "setting the temperature range")
                    ok = setNormalRange(u)
                    setup = "own"
                    if (ok) for (sec in 30 downTo 1) { if (uvc !== u) return@execute; set("settling", "letting the sensor settle", sec); Thread.sleep(1000) }
                }
                if (uvc !== u) return@execute
                if (!ok) { set("failed", "The camera's range setup failed. Unplug it, plug it back in, and try again."); return@execute }
                file?.json(JSONObject().put("k", "setup").put("tables", synchronized(tableHashes) { JSONObject(tableHashes.toString()) }).put("setup", setup).put("words", words()).put("elapsed_ns", SystemClock.elapsedRealtimeNanos()))
                reference(u)
                set("ready")
                main.removeCallbacks(tick); main.postDelayed(tick, 1000)
            } catch (e: Exception) {
                note("setup failed: $e")
                if (uvc === u) set("failed", "The camera's setup stopped: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    private fun unplugged() {
        val u = uvc ?: return
        uvc = null; rangeSet = false; shutterBusy = false; refLeft = 0; busy = null
        main.removeCallbacks(tick)
        file?.json(JSONObject().put("k", "unplug").put("elapsed_ns", SystemClock.elapsedRealtimeNanos()))
        set("unplugged", "The camera was unplugged. Plug it back in: its setup runs again.")
        work.execute { try { u.stop(); u.release() } catch (_: Exception) {} }
    }

    /** A reference every 45 s once the camera is ready (the probe's interval), and never across another job. */
    private val tick = object : Runnable {
        override fun run() {
            val u = uvc
            val now = SystemClock.elapsedRealtime()
            val every = if (now - connectedAt < EARLY_FOR_MS) REFERENCE_EARLY_MS else REFERENCE_EVERY_MS
            if (u != null && state == "ready" && busy == null && now - lastRefAt >= every) work.execute { if (uvc === u) guarded { reference(u) } }
            if (u != null) main.postDelayed(this, 1000)
        }
    }
    private fun guarded(job: () -> Unit) { try { job() } catch (e: Exception) { note("failed: $e"); busy = null; shutterBusy = false } }

    // ---------------- the camera's setup (the probe's readTablesWork / setNormalRangeWork / vbAdjust) ----------------

    private fun readTables(u: Uvc) {
        for ((type, name) in listOf(11 to "kmatrix", 14 to "kmatrix2", 4 to "badpixels", 5 to "vignetting",
                7 to "background-table", 8 to "background", 9 to "coefficients")) {
            // the transfer's own log quotes the tables' first bytes: thrown away, only the outcome is noted
            val d = try { u.downloadFile(type, StringBuilder()) } catch (e: Exception) { null }
            if (d != null) {
                File(tables, "camfile-$type-$name.bin").writeBytes(d)
                // a fingerprint only (the thermal session, 2026-11-15): its runner checks these against the copy it
                // already holds, so the tables themselves never leave the phone
                val h = java.security.MessageDigest.getInstance("SHA-256").digest(d).joinToString("") { "%02x".format(it) }
                synchronized(tableHashes) { tableHashes.put("$type", h) }
            }
            note("table $type $name: ${if (d != null) "${d.size} bytes" else "not read"}")
        }
    }

    private val tableHashes = JSONObject()
    private fun words(): JSONArray = JSONArray().also { a -> lastRow216?.forEach { a.put(it) } }
    private fun modeWords(): String = lastRow216?.let { "words 3/4/10 = ${it[3]}/${it[4]}/${it[10]}" } ?: "no frame yet"

    private val meanLock = Object()
    @Volatile private var meanLeft = 0
    @Volatile private var lastClipped = 0
    private var meanSum = 0.0
    private var meanN = 0
    private var lastClippedSeen = Int.MAX_VALUE

    /** The mean raw count of the picture over the next n frames (for the dark-level loop). */
    private fun meanPictureRaw(n: Int): Double {
        synchronized(meanLock) { meanSum = 0.0; meanN = 0; meanLeft = n }
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) { synchronized(meanLock) { if (meanLeft == 0) return if (meanN > 0) meanSum / meanN else Double.NaN }; Thread.sleep(30) }
        return synchronized(meanLock) { if (meanN > 0) meanSum / meanN else Double.NaN }
    }

    /** The dark-level loop, the shutter already CLOSED: the closed-shutter mean held near 8192 (+-1500) and the
     *  brightest pixels off the 14-bit ceiling, by stepping register 8 in 4s; turns round when nothing moves. */
    private fun vbAdjust(u: Uvc, sb: StringBuilder, maxSteps: Int): Boolean {
        var vb = u.readRegister(8) ?: return false
        var dir = 0
        var lastErr = Double.NaN
        var stuck = 0
        for (step in 0 until maxSteps) {
            val m = meanPictureRaw(8)
            val clipped = lastClipped
            val err = Math.abs(m - 8192)
            sb.append("VB step $step: register 8 = $vb, closed-shutter mean ${Math.round(m)}, clipped $clipped\n")
            if (err <= 1500 && clipped < 20) return true
            val want = if (clipped >= 20 || m > 8192) 1 else -1
            if (dir == 0) dir = want
            else if (!lastErr.isNaN() && err >= lastErr - 1 && clipped >= lastClippedSeen) { if (++stuck >= 2) { dir = -dir; stuck = 0; sb.append("no progress: turning round\n") } }
            else stuck = 0
            lastErr = err; lastClippedSeen = clipped
            vb += 4L * dir
            if (vb < 0 || vb > 255) { sb.append("register 8 out of range; stop\n"); return false }
            u.writeRegister(8, vb); Thread.sleep(400)
        }
        return false
    }

    /** The normal range's register defaults in the vendor app's write order; -1 = filled per device. */
    private val GEAR3 = linkedMapOf(1 to 5L, 2 to 220L, 5 to 3L, 7 to 2L, 8 to 16L, 9 to 42L, 10 to 2L, 14 to 0L, 15 to 59L,
        16 to 0L, 17 to 60L, 18 to 286L, 19 to 0L, 20 to -1L, 12 to 164L, 13 to 170L, 21 to -1L, 6 to -1L, 22 to 127L)

    /** The 19 registers with the camera's own adjustments, then the dark-level loop. True when it settled; if it does
     *  not, the power-on registers are put back. */
    private fun setNormalRange(u: Uvc): Boolean {
        val sb = StringBuilder("set normal range, before: ${modeWords()}\n")
        var ok = false
        try {
            val k = u.responsivityK()
            val rpoly = u.readRegister(0x23); val vebFine = u.readRegister(0x24); val vbPlat = u.readRegister(0x25)
            val bits = u.rdmBits(3)
            if (rpoly == null || vebFine == null || vbPlat == null) throw IllegalStateException("factory values missing: nothing written")
            val regs = LinkedHashMap(GEAR3)
            val t0 = maxOf(regs[17]!!, regs[15]!!)
            regs[2] = (t0 + (regs[2]!! - t0) * k).toLong()
            regs[20] = rpoly; regs[21] = vebFine; regs[6] = vbPlat
            if (bits != null && bits <= 32) regs[22] = if (bits == 32L) 0xFFFFFFFFL else (1L shl bits.toInt()) - 1
            val powerOn = LinkedHashMap<Int, Long>()
            for (t in regs.keys) u.readRegister(t)?.let { powerOn[t] = it }
            for ((t, v) in regs) u.writeRegister(t, v)
            Thread.sleep(500)
            sb.append("after the writes: ${modeWords()}\n")
            u.shutterControl(2); Thread.sleep(500)
            val settled = vbAdjust(u, sb, 16)
            if (!settled) {
                sb.append("dark level did not settle: putting back the power-on registers\n")
                for ((t, v) in powerOn) u.writeRegister(t, v)
                u.shutterControl(3)
                throw IllegalStateException("dark level did not settle")
            }
            u.shutterControl(3); Thread.sleep(300)
            sb.append("done: ${modeWords()}\n")
            ok = true; rangeSet = true
        } catch (e: Exception) { sb.append("failed: $e\n") }
        note(sb.toString())
        file?.json(JSONObject().put("k", "range").put("ok", ok).put("log", sb.toString()))
        return ok
    }

    // ---------------- references, the sky shot, the timing sweep ----------------

    /** The probe's flatFieldNow: close, 400 ms, the dark-level loop, 16 frames, open. On the work thread. */
    private fun reference(u: Uvc) {
        val was = busy
        if (was == null) busy = "reference"
        val t0 = SystemClock.elapsedRealtimeNanos()
        val idx = refIndex + 1
        refIndex = idx
        shutterBusy = true
        val sb = StringBuilder()
        var settled: Boolean? = null
        try {
            u.shutterControl(2)
            Thread.sleep(400)
            if (rangeSet) settled = try { vbAdjust(u, sb, 8) } catch (e: Exception) { sb.append("failed: $e\n"); false }
            wantBase = true
            refLeft = REFERENCE_FRAMES
            val end = System.currentTimeMillis() + 5000
            while (refLeft > 0 && System.currentTimeMillis() < end) Thread.sleep(20)
            val got = REFERENCE_FRAMES - refLeft
            refLeft = 0
            u.shutterControl(3)
            Thread.sleep(300)
            val t1 = SystemClock.elapsedRealtimeNanos()
            file?.json(JSONObject().put("k", "ref").put("index", idx).put("t0_ns", t0).put("t1_ns", t1).put("frames", got)
                .put("dark_level", if (settled == null) "not run (the vendor's setup)" else if (settled) "settled" else "not settled").put("log", sb.toString()).put("words", words()))
        } finally {
            shutterBusy = false
            lastRefAt = SystemClock.elapsedRealtime()
            if (was == null) busy = null
        }
    }

    /** A sky shot ("start" or "end"): a fresh reference, then 2 s of every frame, the phone pointing straight up
     *  (within 20 degrees, by ARCore's pose; refused otherwise, and when ARCore is not running to say). */
    fun skyShot(label: String): Boolean {
        if (!(upDeg <= SKY_WITHIN_DEG)) return false
        return timed("sky", label.take(12), SKY_MS, true) { skyUntil = it }
    }

    /** A timing sweep: 5 s of every frame while the phone sweeps past something hot. */
    fun sweep(): Boolean = timed("sweep", "", SWEEP_MS, false) { sweepUntil = it }

    private fun timed(what: String, label: String, ms: Long, fresh: Boolean, until: (Long) -> Unit): Boolean {
        val u = uvc ?: return false
        if (state != "ready" || busy != null) return false
        busy = what
        work.execute {
            try {
                if (uvc !== u) return@execute
                if (fresh) reference(u)
                val t0 = SystemClock.elapsedRealtimeNanos()
                val up0 = upDeg
                until(t0 + ms * 1_000_000)
                Thread.sleep(ms)
                file?.json(JSONObject().put("k", what).put("label", label).put("t0_ns", t0).put("t1_ns", t0 + ms * 1_000_000)
                    .put("up_deg_start", if (up0.isNaN()) JSONObject.NULL else Math.round(up0 * 10) / 10.0)
                    .put("up_deg_end", if (upDeg.isNaN()) JSONObject.NULL else Math.round(upDeg * 10) / 10.0))
            } catch (e: Exception) { note("$what failed: $e") } finally { busy = null }
        }
        return true
    }

    // ---------------- frames ----------------

    private fun onFrame(fd: UvcFrameData) {
        val b = fd.bytes; val w = width
        if (b.size >= w * ROWS * 2) {
            lastRow216 = IntArray(24) { val i = 2 * (216 * w + it); (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) }
            synchronized(meanLock) {
                if (meanLeft > 0) {
                    var sum = 0L; var n = 0; var clip = 0
                    for (y in 2 until 194) for (x in 4 until 260) {
                        val i = 2 * (y * w + x); val v = (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8)
                        sum += v; n++; if (v >= 16383) clip++
                    }
                    meanSum += sum.toDouble() / n; meanN++; meanLeft--; lastClipped = clip
                }
            }
        }
        seen++
        val t = fd.tNanos
        synchronized(times) {
            times.addLast(t); while (times.size > 30) times.removeFirst()
            if (times.size > 2) fps = (times.size - 1) * 1e9 / (times.last() - times.first())
        }
        val n = ++seq
        val f = file ?: run { if (refLeft > 0) refLeft--; return }
        val isRef = refLeft > 0
        if (isRef) refLeft--
        val type = when { isRef -> REFERENCE; shutterBusy -> SHUTTER; t < skyUntil -> SKY; t < sweepUntil -> SWEEP; else -> SCENE }
        val every = type == REFERENCE || type == SKY || type == SWEEP
        if (!every && n % KEEP_EVERY != 0) return
        if (b.size < w * KEEP_ROWS * 2 || w < KEEP_COLS) return   // not a whole frame: not kept
        // rows 0-216, columns 0-259, as they came
        val crop = ByteArray(KEEP_ROWS * KEEP_COLS * 2)
        for (y in 0 until KEEP_ROWS) System.arraycopy(b, 2 * y * w, crop, 2 * y * KEEP_COLS, 2 * KEEP_COLS)
        if (isRef && wantBase) {
            // a reference's first frame: written as it is, and what the frames after it are packed against. If the
            // file cannot take it, nothing is packed against it.
            wantBase = false
            if (f.frame(type, n, refIndex, 0, crop, fd, KEEP_COLS, KEEP_ROWS)) { baseFrame = crop; baseSeq = n } else baseFrame = null
            return
        }
        val base = baseFrame
        if (base == null) { f.frame(type, n, refIndex, 0, crop, fd, KEEP_COLS, KEEP_ROWS); return }
        // each 16-bit number minus the base frame's, modulo 65536 (little-endian): the exact numbers come back by adding
        var i = 0
        while (i < crop.size) {
            val v = ((crop[i].toInt() and 0xff) or ((crop[i + 1].toInt() and 0xff) shl 8)) - ((base[i].toInt() and 0xff) or ((base[i + 1].toInt() and 0xff) shl 8))
            crop[i] = v.toByte(); crop[i + 1] = (v shr 8).toByte()
            i += 2
        }
        f.frame(type, n, refIndex, baseSeq, crop, fd, KEEP_COLS, KEEP_ROWS)
    }

    // ---------------- a walk ----------------

    /** Start keeping frames for this walk. False when no camera is connected (the walk goes on without it). */
    fun startWalk(id: String): Boolean {
        val safe = id.replace(Regex("[^0-9a-zA-Z_-]"), "").take(40)
        if (safe.isEmpty() || uvc == null || file != null) return false
        val f = ThermalFile(File(uploads.dir, "$safe.bin"))
        f.json(JSONObject().put("k", "start").put("format", 1).put("walk", safe)
            .put("wall_ms", System.currentTimeMillis()).put("elapsed_ns", SystemClock.elapsedRealtimeNanos())
            .put("width", KEEP_COLS).put("rows", KEEP_ROWS).put("camera_width", width).put("camera_rows", ROWS).put("keep_every", KEEP_EVERY)
            .put("crop", JSONArray(listOf(0, KEEP_ROWS - 1, 0, KEEP_COLS - 1))).put("base", "first frame of reference")
            .put("tables", synchronized(tableHashes) { JSONObject(tableHashes.toString()) }).put("setup", setup).put("state", state).put("words", words())
            .put("app", BuildConfig.VERSION_NAME).put("phone", "${Build.MANUFACTURER} ${Build.MODEL}").put("android", Build.VERSION.SDK_INT))
        baseFrame = null; baseSeq = 0   // a file's frames are packed only against a frame in that file
        uploads.writing = safe
        walk = safe; file = f
        // the walk's file opens with a reference of its own
        val u = uvc
        if (u != null && state == "ready") work.execute { if (uvc === u && busy == null) guarded { reference(u) } }
        return true
    }

    /** The walk is over: the file closed and sent (ThermalUpload). */
    fun endWalk() {
        val f = file ?: return
        file = null; walk = null
        f.json(JSONObject().put("k", "end").put("elapsed_ns", SystemClock.elapsedRealtimeNanos()).put("frames", f.frames).put("dropped", f.dropped))
        f.close { uploads.writing = null; uploads.sendAll() }
    }

    /**
     * Every ARCore frame (ArEngine): the physical camera's pose (Camera.getPose(), in ARCore's own world: metres, y up)
     * with ARCore's timestamp and this clock read beside it. Kept in the walk's file; also the tilt for the sky shot.
     */
    fun arFrame(timestampNs: Long, pose: Pose?, tracking: Boolean) {
        if (pose == null || !tracking) { upDeg = Double.NaN } else {
            // the camera looks along its own -z; ARCore's world y is up
            val z = pose.zAxis
            upDeg = Math.toDegrees(Math.acos((-z[1]).toDouble().coerceIn(-1.0, 1.0)))
        }
        val f = file ?: return
        if (pose != null) f.pose(timestampNs, SystemClock.elapsedRealtimeNanos(), pose, tracking)
    }

    fun status(): String {
        val f = file
        return JSONObject().put("state", state).put("detail", detail).put("secs", secs).put("busy", busy ?: JSONObject.NULL)
            .put("present", uvc != null || present()).put("setup", setup).put("fps", Math.round(fps * 10) / 10.0).put("seen", seen)
            .put("refs", refIndex).put("refAgoS", if (lastRefAt > 0) (SystemClock.elapsedRealtime() - lastRefAt) / 1000 else JSONObject.NULL)
            .put("walk", walk ?: JSONObject.NULL).put("kept", f?.frames ?: 0).put("poses", f?.poses ?: 0).put("dropped", f?.dropped ?: 0).put("bytes", f?.bytes ?: 0)
            .put("upDeg", if (upDeg.isNaN()) JSONObject.NULL else Math.round(upDeg)).put("upload", uploads.status()).toString()
    }

    /** The setup's log, for the page to show when something failed (no table bytes, no serial number). */
    fun log(): String = synchronized(notes) { notes.toString().takeLast(6000) }
}
