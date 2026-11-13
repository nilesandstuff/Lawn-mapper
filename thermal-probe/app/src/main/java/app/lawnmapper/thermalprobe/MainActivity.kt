package app.lawnmapper.thermalprobe

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/*
 * THE THERMAL PROBE (thermal-probe/README.md). One screen:
 *
 *   Connect           asks for the camera permission (Android's rule for UVC devices), then the USB device, then
 *                     reads every descriptor and control and starts the camera's default stream.
 *   Sky / Hand / Ice water / Other
 *                     saves one second of raw frames, labelled.
 *   Flat-field        closes the shutter, saves 10 frames of it (a "shutter" capture) and keeps their average as
 *                     the offset the preview subtracts, then opens it. Done once by itself on connect.
 *   Open / Close      drive the shutter (Uvc.shutter). The camera sends RAW detector counts: the shutter is
 *                     the only uniform reference, and the phone, not the camera, does the correction.
 *   Save & share      zips everything into Downloads/ThermalProbe and opens the share sheet.
 *
 * Nothing is decoded for real here: the frames are saved as the camera sent them, and the preview only GUESSES that
 * they are 16-bit numbers, to have something to aim with.
 */
class MainActivity : Activity() {

    // the SK02's 264x222 frame: the picture in the first 215 rows and 256 columns (a guess from the first captures);
    // the last rows and the columns past 256 carry numbers that are not picture (shown pink)
    private val IMAGE_ROWS = 215
    private val IMAGE_COLS = 256

    private val ACTION_USB = "app.lawnmapper.thermalprobe.USB_PERMISSION"
    private lateinit var usb: UsbManager
    private var uvc: Uvc? = null
    private var device: UsbDevice? = null

    private lateinit var status: TextView
    private lateinit var image: ImageView
    private lateinit var readout: TextView
    private lateinit var logView: TextView
    private lateinit var labelEdit: EditText

    private val logLines = StringBuilder()
    private val stamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private lateinit var work: File
    private var captureCount = 0

    // the stream now running
    @Volatile private var curFormat: UvcFormat? = null
    @Volatile private var curFrame: UvcFrame? = null
    private var lastPreview = 0L
    private val frameTimes = ArrayDeque<Long>()

    // the flat-field: the shutter's average frame, subtracted in the preview
    private val nucLock = Object()
    @Volatile private var offset: FloatArray? = null
    private var nucSum: DoubleArray? = null
    private var nucCount = 0
    private var nucLeft = 0

    // a capture in progress
    private val capLock = Object()
    private var capOut: BufferedOutputStream? = null
    private var capCsv: StringBuilder? = null
    private var capName = ""
    private var capLeft = 0
    private var capIndex = 0
    private var capDone: (() -> Unit)? = null

    private fun log(msg: String) {
        val line = "${stamp.format(Date())} $msg"
        synchronized(logLines) { logLines.append(line).append('\n') }
        runOnUiThread {
            val all = synchronized(logLines) { logLines.toString() }
            val lines = all.trimEnd().split('\n')
            logView.text = lines.takeLast(40).joinToString("\n")
        }
    }

    private fun setStatus(s: String) = runOnUiThread { status.text = s }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        usb = getSystemService(Context.USB_SERVICE) as UsbManager
        work = File(cacheDir, "probe").apply { deleteRecursively(); mkdirs() }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        status = TextView(this).apply { textSize = 16f; text = "Plug in the thermal camera, then tap Connect." }
        image = ImageView(this).apply {
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.DKGRAY)
            minimumHeight = 300
        }
        readout = TextView(this).apply { textSize = 13f; typeface = android.graphics.Typeface.MONOSPACE }
        labelEdit = EditText(this).apply { hint = "label for Other (e.g. grass sun)"; setSingleLine() }
        logView = TextView(this).apply { textSize = 11f; typeface = android.graphics.Typeface.MONOSPACE }

        fun button(text: String, onClick: () -> Unit) = Button(this).apply {
            this.text = text; isAllCaps = false; setOnClickListener { onClick() }
        }
        fun row(vararg b: Button) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            for (x in b) addView(x, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }

        root.addView(status)
        root.addView(image, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(readout)
        root.addView(row(button("Connect") { connect() }, button("Save & share") { saveAndShare() }))
        root.addView(row(
            button("Sky") { capture("sky", 25) },
            button("Hand") { capture("hand", 25) },
            button("Ice water") { capture("ice", 25) },
        ))
        root.addView(labelEdit)
        root.addView(row(
            button("Other") { capture(labelEdit.text.toString().ifBlank { "other" }, 25) },
            button("Flat-field") { flatField() },
        ))
        root.addView(row(
            button("Open shutter") { shutterCmd(true) },
            button("Close shutter") { shutterCmd(false) },
        ))
        root.addView(row(
            button("SK01 close") { sk01(2) },
            button("SK01 open") { sk01(3) },
            button("Read block") { readEnh() },
        ))
        root.addView(row(
            button("Hik bind") { hikBind() },
            button("Hik shutter") { hikShutter() },
        ))
        root.addView(row(
            button("Correct A") { correct(0x0000) },
            button("Correct B") { correct(0x0A00) },
        ))
        root.addView(logView)
        setContentView(ScrollView(this).apply { addView(root) })

        val filter = IntentFilter().apply { addAction(ACTION_USB); addAction(UsbManager.ACTION_USB_DEVICE_DETACHED) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else registerReceiver(receiver, filter)

        log("Thermal Probe ${packageManager.getPackageInfo(packageName, 0).versionName}, Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}")
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            log("camera plugged in (opened from Android's prompt)")
            connect()
        }
    }

    override fun onDestroy() {
        try { unregisterReceiver(receiver) } catch (_: Exception) {}
        uvc?.release()
        super.onDestroy()
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                ACTION_USB -> {
                    val granted = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    log("USB permission: " + if (granted) "granted" else "refused")
                    if (granted) device?.let { open(it) } else setStatus("USB access was refused. Tap Connect to ask again.")
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    log("camera unplugged")
                    uvc?.let { it.stop(); try { it.release() } catch (_: Exception) {} }
                    uvc = null
                    setStatus("Camera unplugged. Plug it back in and tap Connect.")
                }
            }
        }
    }

    // ---------------- connecting ----------------

    private fun findCamera(): UsbDevice? {
        val all = usb.deviceList.values
        for (d in all) log(String.format("USB device %04x:%04x %s / %s, %d interfaces", d.vendorId, d.productId,
            d.manufacturerName ?: "?", d.productName ?: "?", d.interfaceCount))
        return all.firstOrNull { it.vendorId == 0x38BE } ?: all.firstOrNull { d ->
            (0 until d.interfaceCount).any { d.getInterface(it).interfaceClass == 0x0e }
        }
    }

    private fun connect() {
        if (uvc != null) { log("already connected"); return }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            setStatus("Android needs the camera permission before it lets an app open a USB camera.")
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
            return
        }
        val d = findCamera() ?: run { setStatus("No USB video device found. Is the camera plugged in?"); return }
        device = d
        if (usb.hasPermission(d)) { open(d); return }
        val pi = PendingIntent.getBroadcast(this, 0, Intent(ACTION_USB).setPackage(packageName), PendingIntent.FLAG_MUTABLE)
        setStatus("Asking for USB access: tap Allow.")
        usb.requestPermission(d, pi)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) connect()
        else setStatus("Without the camera permission Android will not open the USB camera.")
    }

    private fun open(d: UsbDevice) {
        if (uvc != null) return
        val conn = usb.openDevice(d) ?: run { setStatus("Android would not open the device."); return }
        val u = Uvc(d, conn, ::log)
        uvc = u
        log(String.format("opened %04x:%04x, serial %s", d.vendorId, d.productId, try { d.serialNumber } catch (_: Exception) { "?" }))
        u.claimAll()
        File(work, "descriptors.hex").writeText(hex(u.raw) + "\n")
        val sb = StringBuilder()
        for (f in u.desc.formats) {
            sb.append("format ${f.index}: ${f.kind} ${f.fourcc} ${f.bitsPerPixel} bpp guid ${f.guid}\n")
            for (fr in f.frames) sb.append("  frame ${fr.frameIndex}: ${fr.width}x${fr.height}, default interval ${fr.defaultInterval} (${fpsOf(fr.defaultInterval)} fps), intervals ${fr.intervals}, max buffer ${fr.maxBuffer}\n")
        }
        log("formats:\n$sb")
        Thread {
            val controls = try { u.readAllControls() } catch (e: Exception) { "control read failed: $e" }
            File(work, "controls.txt").writeText(controls)
            log("controls read (${controls.lines().size} lines, saved)")
            val f = u.desc.formats.firstOrNull()
            val fr = f?.frames?.firstOrNull()
            if (f == null || fr == null) { setStatus("The camera listed no video format: send the file anyway (Save & share)."); return@Thread }
            if (startStream(f, fr)) {
                Thread.sleep(500)
                val vi = try { u.vendorInfo() } catch (e: Exception) { "vendor reads failed: $e" }
                File(work, "vendor.txt").writeText(vi)
                log(vi)
                val hb = try { u.hikBind() } catch (e: Exception) { "hik bind failed: $e" }
                File(work, "hik-bind-connect.txt").writeText(hb)
                log(hb)
                val eb = try { u.enhRead() } catch (e: Exception) { null }
                File(work, "enhancement-connect.txt").writeText("${eb?.size ?: -1} B ${eb?.let { hex(it) }}")
                log("enhancement block on connect: ${eb?.size ?: -1} B")
                setStatus("Connected and bound. Try SK01 close / open.")
            }
        }.start()
    }

    private fun fpsOf(interval: Long) = if (interval > 0) String.format(Locale.US, "%.1f", 1e7 / interval) else "?"

    private fun startStream(f: UvcFormat, fr: UvcFrame): Boolean {
        val u = uvc ?: return false
        u.stop()
        if (!u.commit(f.index, fr.frameIndex, fr.defaultInterval)) { setStatus("The camera refused format ${f.index} frame ${fr.frameIndex}."); return false }
        curFormat = f; curFrame = fr
        synchronized(frameTimes) { frameTimes.clear() }
        u.start(::onFrame)
        setStatus("Streaming ${f.fourcc} ${fr.width}x${fr.height}. Aim, then tap a capture button.")
        return true
    }

    // ---------------- frames ----------------

    private fun onFrame(fd: UvcFrameData) {
        synchronized(nucLock) {
            if (nucLeft > 0) {
                val b = fd.bytes
                val n = b.size / 2
                val sum = nucSum ?: DoubleArray(n).also { nucSum = it }
                if (sum.size == n) {
                    for (k in 0 until n) sum[k] += ((b[2 * k].toInt() and 0xff) or ((b[2 * k + 1].toInt() and 0xff) shl 8)).toDouble()
                    nucCount++
                }
                nucLeft--
                if (nucLeft == 0 && nucCount > 0) {
                    offset = FloatArray(n) { (sum[it] / nucCount).toFloat() }
                    nucSum = null
                }
            }
        }
        synchronized(capLock) {
            val out = capOut
            if (out != null && capLeft > 0) {
                out.write(fd.bytes)
                capCsv!!.append("$capIndex,${fd.bytes.size},${fd.tNanos},${fd.pts},${fd.scr},${fd.payloads},${fd.errors}\n")
                capIndex++
                capLeft--
                if (capLeft == 0) finishCapture()
            }
        }
        val now = System.nanoTime()
        synchronized(frameTimes) {
            frameTimes.addLast(now)
            while (frameTimes.size > 30) frameTimes.removeFirst()
        }
        if (now - lastPreview > 150_000_000L) {
            lastPreview = now
            preview(fd)
        }
    }

    private fun preview(fd: UvcFrameData) {
        val fr = curFrame ?: return
        val w = fr.width
        val b = fd.bytes
        val fps = synchronized(frameTimes) {
            if (frameTimes.size > 2) (frameTimes.size - 1) * 1e9 / (frameTimes.last() - frameTimes.first()) else 0.0
        }
        val text = StringBuilder()
        text.append(String.format(Locale.US, "frame %d bytes (expected %dx%dx2 = %d), %.1f fps, %d payloads%s\n",
            b.size, w, fr.height, w * fr.height * 2, fps, fd.payloads, if (fd.errors > 0) ", ${fd.errors} errors" else ""))
        val bmp: Bitmap
        if (w > 0 && b.size >= w * 2 && b.size % (w * 2) == 0) {
            // GUESS: 16-bit little-endian numbers, one per pixel; rows past the descriptor's height shown too
            val rows = b.size / (w * 2)
            val raw = IntArray(w * rows) { (b[2 * it].toInt() and 0xff) or ((b[2 * it + 1].toInt() and 0xff) shl 8) }
            val off = offset?.takeIf { it.size == raw.size }
            // with a flat-field: counts above the shutter's (the scene); without: the raw counts
            val v = if (off != null) IntArray(raw.size) { raw[it] - off[it].toInt() } else raw
            val imgRows = minOf(rows, IMAGE_ROWS)
            // stretch between the 1st and 99th percentiles, so a few odd values cannot flatten the picture
            val sorted = IntArray(imgRows * minOf(w, IMAGE_COLS)) { v[(it / minOf(w, IMAGE_COLS)) * w + it % minOf(w, IMAGE_COLS)] }.also { it.sort() }
            val lo = sorted[sorted.size / 100]
            val hi = sorted[sorted.size - 1 - sorted.size / 100]
            val span = maxOf(1, hi - lo)
            val px = IntArray(w * rows) {
                val g = ((v[it] - lo) * 255L / span).toInt().coerceIn(0, 255)
                if (it >= w * imgRows || it % w >= IMAGE_COLS) Color.rgb(g, 0, g) else Color.rgb(g, g, g)
            }
            bmp = Bitmap.createBitmap(px, w, rows, Bitmap.Config.ARGB_8888)
            val cx = minOf(w, IMAGE_COLS) / 2; val cy = imgRows / 2
            var sum = 0L; var sumRaw = 0L; var n = 0
            for (dy in -1..1) for (dx in -1..1) { sum += v[(cy + dy) * w + cx + dx]; sumRaw += raw[(cy + dy) * w + cx + dx]; n++ }
            text.append(String.format(Locale.US, "%s, 1%%-99%% %d..%d\n", if (off != null) "flat-fielded" else "RAW (no flat-field yet)", lo, hi))
            text.append(String.format(Locale.US, "centre: %.0f counts above shutter, raw %.0f\n", if (off != null) sum.toDouble() / n else Double.NaN, sumRaw.toDouble() / n))
            if (rows > IMAGE_ROWS + 1) text.append(String.format(Locale.US, "meta: r215[4]=%d r215[5]=%d r216[1]=%d r216[5]=%d\n",
                raw[215 * w + 4], raw[215 * w + 5], raw[216 * w + 1], raw[216 * w + 5]))
        } else {
            val rows = maxOf(1, b.size / maxOf(1, w))
            val px = IntArray(w * rows) { val g = b[it].toInt() and 0xff; Color.rgb(g, g, g) }
            bmp = Bitmap.createBitmap(px, w, rows, Bitmap.Config.ARGB_8888)
            text.append("not a whole number of 16-bit rows; shown as bytes\n")
        }
        val scaled = Bitmap.createScaledBitmap(bmp, bmp.width * 3, bmp.height * 3, false)
        runOnUiThread {
            image.setImageBitmap(scaled)
            readout.text = text.toString().trimEnd()
        }
    }

    // ---------------- captures ----------------

    private fun capture(label: String, frames: Int, done: (() -> Unit)? = null) {
        val f = curFormat; val fr = curFrame
        if (uvc == null || f == null || fr == null) { setStatus("Connect first."); return }
        synchronized(capLock) {
            if (capOut != null) { log("a capture is already running"); return }
            captureCount++
            val safe = label.lowercase(Locale.US).replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "x" }
            capName = String.format(Locale.US, "%02d_%s_fmt%d-%s_frame%d_%dx%d", captureCount, safe, f.index, f.fourcc.trim(), fr.frameIndex, fr.width, fr.height)
            capOut = BufferedOutputStream(FileOutputStream(File(work, "$capName.bin")))
            capCsv = StringBuilder("index,bytes,elapsed_realtime_ns,uvc_pts,uvc_scr,payloads,errors\n")
            capLeft = frames
            capIndex = 0
            capDone = done
        }
        setStatus("Capturing \"$label\"... hold still.")
    }

    private fun finishCapture() { // under capLock
        capOut?.close()
        File(work, "$capName.csv").writeText(capCsv.toString())
        log("saved $capName ($capIndex frames)")
        capOut = null; capCsv = null
        val d = capDone; capDone = null
        setStatus("Saved \"$capName\". Next capture, or Save & share.")
        d?.invoke()
    }

    private fun waitForCapture(timeoutMs: Long): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            synchronized(capLock) { if (capOut == null) return true }
            Thread.sleep(50)
        }
        synchronized(capLock) {
            if (capOut != null) { log("capture $capName timed out after $capIndex frames"); finishCapture() }
        }
        return false
    }

    private fun survey() {
        val u = uvc ?: run { setStatus("Connect first."); return }
        val back = curFormat to curFrame
        Thread {
            for (f in u.desc.formats) for (fr in f.frames) {
                setStatus("Survey: format ${f.index} ${f.fourcc} ${fr.width}x${fr.height}")
                if (!startStream(f, fr)) continue
                Thread.sleep(400)
                capture("survey", 10)
                waitForCapture(5000)
            }
            val (bf, bfr) = back
            if (bf != null && bfr != null) startStream(bf, bfr)
            log("survey finished")
        }.start()
    }

    private fun shutterCmd(open: Boolean) {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread { log(u.shutter(open)); setStatus(if (open) "Shutter opened." else "Shutter closed.") }.start()
    }

    private fun sk01(control: Int) {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread {
            capture(if (control == 2) "sk01-close" else "sk01-open", 25)
            Thread.sleep(80)
            val r = try { u.sk01Shutter(control) } catch (e: Exception) { "sk01 shutter failed: $e" }
            log(r); setStatus("$r. Did it click?")
        }.start()
    }

    private fun readEnh() {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread {
            val r = try { u.enhRead() } catch (e: Exception) { null }
            val t = "enhancement block: ${r?.let { "${it.size} B ${hex(it)}" } ?: "failed"}"
            File(work, "enhancement-${System.currentTimeMillis() % 100000}.txt").writeText(t)
            log(t); setStatus("Block read (in the log).")
        }.start()
    }

    private fun hikBind() {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread {
            val r = try { u.hikBind() } catch (e: Exception) { "hik bind failed: $e" }
            File(work, "hik-bind-${System.currentTimeMillis() % 100000}.txt").writeText(r)
            log(r); setStatus("Bind done (see the log).")
        }.start()
    }

    /** The documented manual shutter; records 2 s of frames from the moment it is sent. */
    private fun hikShutter() {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread {
            capture("hik-shutter", 50)
            Thread.sleep(80)
            val r = try { u.hikManualShutter() } catch (e: Exception) { "hik shutter failed: $e" }
            log(r); setStatus("$r. Did it click?")
        }.start()
    }

    /** HIKMICRO's manual correction (Uvc.manualCorrect); A as decoded, B aimed at extension unit 10. */
    private fun correct(wIndex: Int) {
        val u = uvc ?: run { setStatus("Connect first."); return }
        Thread {
            val r = u.manualCorrect(wIndex)
            log(r)
            setStatus("$r. Did it click?")
            Thread.sleep(300)
            capture(if (wIndex == 0) "after-correct-a" else "after-correct-b", 50)
        }.start()
    }

    private fun flatField() {
        if (uvc == null) { setStatus("Connect first."); return }
        Thread { flatFieldNow() }.start()
    }

    /** Close, settle, save 10 frames as a "shutter" capture and average them as the offset, open. Off the UI thread. */
    private fun flatFieldNow() {
        val u = uvc ?: return
        setStatus("Flat-field: closing the shutter...")
        log(u.sk01Shutter(2))
        Thread.sleep(400)
        synchronized(nucLock) { nucSum = null; nucCount = 0; nucLeft = 10 }
        capture("shutter", 10)
        waitForCapture(5000)
        log(u.sk01Shutter(3))
        Thread.sleep(300)
        setStatus("Flat-field done; the shutter is open. Aim, then tap a capture button.")
    }

    // ---------------- sharing ----------------

    private fun saveAndShare() {
        Thread {
            synchronized(capLock) { if (capOut != null) finishCapture() }
            uvc?.let { File(work, "payload-headers.txt").writeText(synchronized(it.payloadLog) { it.payloadLog.toString() }) }
            File(work, "log.txt").writeText(synchronized(logLines) { logLines.toString() })
            val name = "thermal-probe-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".zip"
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/ThermalProbe")
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri == null) { setStatus("Could not create the file in Downloads."); return@Thread }
            var bytes = 0L
            contentResolver.openOutputStream(uri)!!.use { os ->
                ZipOutputStream(BufferedOutputStream(os)).use { zip ->
                    for (f in work.listFiles()!!.sortedBy { it.name }) {
                        zip.putNextEntry(ZipEntry(f.name))
                        f.inputStream().use { it.copyTo(zip) }
                        zip.closeEntry()
                        bytes += f.length()
                    }
                }
            }
            log("saved Download/ThermalProbe/$name (${bytes / 1024} KB before zipping)")
            setStatus("Saved Download/ThermalProbe/$name")
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "application/zip"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(send, "Send the probe file"))
            }
        }.start()
    }
}
