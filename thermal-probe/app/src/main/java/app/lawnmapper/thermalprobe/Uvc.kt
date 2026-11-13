package app.lawnmapper.thermalprobe

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.os.SystemClock

/*
 * A minimal USB Video Class host, on Android's own USB API (no libusb): enough to read every descriptor, read the
 * camera's controls, choose a stream, and pull frames off a BULK streaming endpoint (the SK02 has no isochronous
 * alternate settings, so nothing here needs native code).
 *
 * Everything this learns is also written to the log as raw hex, so the decoding can be redone offline if the parse
 * here is wrong.
 */

fun hex(b: ByteArray, off: Int = 0, len: Int = b.size - off): String {
    val sb = StringBuilder()
    for (i in off until minOf(b.size, off + len)) sb.append(String.format("%02x", b[i].toInt() and 0xff))
    return sb.toString()
}

private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xff
private fun u16(b: ByteArray, i: Int) = u8(b, i) or (u8(b, i + 1) shl 8)
private fun u32(b: ByteArray, i: Int): Long = (u16(b, i).toLong()) or (u16(b, i + 2).toLong() shl 16)

private fun putU32(b: ByteArray, i: Int, v: Long) {
    b[i] = (v and 0xff).toByte(); b[i + 1] = ((v shr 8) and 0xff).toByte()
    b[i + 2] = ((v shr 16) and 0xff).toByte(); b[i + 3] = ((v shr 24) and 0xff).toByte()
}

/** One frame size of one format (a VS_FRAME_* descriptor). */
data class UvcFrame(
    val formatIndex: Int, val frameIndex: Int, val width: Int, val height: Int,
    val defaultInterval: Long, val intervals: List<Long>, val maxBuffer: Long,
)

/** One format (a VS_FORMAT_* descriptor) and its frames. */
data class UvcFormat(
    val index: Int, val kind: String, val fourcc: String, val bitsPerPixel: Int, val guid: String,
    val frames: MutableList<UvcFrame> = mutableListOf(),
)

/** A unit or terminal of the video-control interface, with the controls its bitmap says it has. */
data class UvcUnit(val kind: String, val id: Int, val guid: String, val controlBits: ByteArray, val raw: String)

class UvcDescriptors(raw: ByteArray, val log: (String) -> Unit) {
    var bcdUvc = 0x0100
    var vcInterface = 0
    var vsInterface = 1
    val formats = mutableListOf<UvcFormat>()
    val units = mutableListOf<UvcUnit>()

    init {
        var i = 0
        var curIfaceClass = -1
        var curIfaceSub = -1
        var curIfaceNum = -1
        while (i + 2 <= raw.size) {
            val len = u8(raw, i)
            val type = u8(raw, i + 1)
            if (len < 2 || i + len > raw.size) { log("descriptor walk stopped at byte $i (length $len)"); break }
            val d = raw.copyOfRange(i, i + len)
            when (type) {
                0x04 -> { // INTERFACE
                    curIfaceNum = u8(d, 2); curIfaceClass = u8(d, 5); curIfaceSub = u8(d, 6)
                    if (curIfaceClass == 0x0e && curIfaceSub == 1) vcInterface = curIfaceNum
                    if (curIfaceClass == 0x0e && curIfaceSub == 2) vsInterface = curIfaceNum
                }
                0x24 -> if (curIfaceClass == 0x0e && len >= 3) {
                    if (curIfaceSub == 1) parseVc(d) else if (curIfaceSub == 2) parseVs(d)
                }
            }
            i += len
        }
    }

    private fun guidOf(d: ByteArray, at: Int): String = if (d.size >= at + 16) hex(d, at, 16) else ""
    private fun fourccOf(d: ByteArray, at: Int): String {
        if (d.size < at + 4) return "?"
        val s = String(d, at, 4, Charsets.ISO_8859_1)
        return if (s.all { it.code in 32..126 }) s else hex(d, at, 4)
    }

    private fun parseVc(d: ByteArray) {
        when (u8(d, 2)) {
            0x01 -> if (d.size >= 5) bcdUvc = u16(d, 3)
            0x02 -> { // INPUT_TERMINAL; a camera terminal (0x0201) has bControlSize at 14
                val type = if (d.size >= 6) u16(d, 4) else 0
                val bits = if (type == 0x0201 && d.size >= 15) d.copyOfRange(15, minOf(d.size, 15 + u8(d, 14))) else ByteArray(0)
                units += UvcUnit(String.format("input terminal 0x%04x", type), u8(d, 3), "", bits, hex(d))
            }
            0x03 -> units += UvcUnit("output terminal", u8(d, 3), "", ByteArray(0), hex(d))
            0x05 -> { // PROCESSING_UNIT
                val size = if (d.size >= 8) u8(d, 7) else 0
                units += UvcUnit("processing unit", u8(d, 3), "", d.copyOfRange(minOf(8, d.size), minOf(d.size, 8 + size)), hex(d))
            }
            0x06 -> { // EXTENSION_UNIT
                val nIn = if (d.size >= 22) u8(d, 21) else 0
                val sizeAt = 22 + nIn
                val size = if (d.size > sizeAt) u8(d, sizeAt) else 0
                val bits = if (d.size > sizeAt) d.copyOfRange(sizeAt + 1, minOf(d.size, sizeAt + 1 + size)) else ByteArray(0)
                units += UvcUnit("extension unit", u8(d, 3), guidOf(d, 4), bits, hex(d))
            }
            else -> units += UvcUnit(String.format("vc subtype 0x%02x", u8(d, 2)), if (d.size > 3) u8(d, 3) else -1, "", ByteArray(0), hex(d))
        }
    }

    private fun parseVs(d: ByteArray) {
        val sub = u8(d, 2)
        when (sub) {
            0x04, 0x10 -> if (d.size >= 22) // FORMAT_UNCOMPRESSED, FORMAT_FRAME_BASED
                formats += UvcFormat(u8(d, 3), if (sub == 0x04) "uncompressed" else "frame-based", fourccOf(d, 5), u8(d, 21), guidOf(d, 5))
            0x06 -> if (d.size >= 4) formats += UvcFormat(u8(d, 3), "mjpeg", "MJPG", 0, "")
            0x05, 0x07 -> if (d.size >= 26 && formats.isNotEmpty()) { // FRAME_UNCOMPRESSED, FRAME_MJPEG
                val n = u8(d, 25)
                val iv = mutableListOf<Long>()
                if (n == 0) { for (k in 0 until 3) if (d.size >= 30 + 4 * k) iv += u32(d, 26 + 4 * k) }
                else for (k in 0 until n) if (d.size >= 30 + 4 * k) iv += u32(d, 26 + 4 * k)
                formats.last().frames += UvcFrame(formats.last().index, u8(d, 3), u16(d, 5), u16(d, 7), u32(d, 21), iv, u32(d, 17))
            }
            0x11 -> if (d.size >= 26 && formats.isNotEmpty()) { // FRAME_FRAME_BASED
                val n = u8(d, 21)
                val iv = mutableListOf<Long>()
                for (k in 0 until (if (n == 0) 3 else n)) if (d.size >= 30 + 4 * k) iv += u32(d, 26 + 4 * k)
                formats.last().frames += UvcFrame(formats.last().index, u8(d, 3), u16(d, 5), u16(d, 7), u32(d, 17), iv, 0)
            }
        }
    }
}

/** What a finished frame carries: its bytes and when it arrived. */
class UvcFrameData(val bytes: ByteArray, val tNanos: Long, val pts: Long, val scr: String, val payloads: Int, val errors: Int)

class Uvc(val device: UsbDevice, val conn: UsbDeviceConnection, val log: (String) -> Unit) {
    val raw: ByteArray = conn.rawDescriptors ?: ByteArray(0)
    val desc = UvcDescriptors(raw, log)
    private val claimed = mutableListOf<UsbInterface>()
    var bulkIn: UsbEndpoint? = null
    var probeLen = 26
    var committed: ByteArray? = null
    var maxPayload = 0L
    var maxFrame = 0L

    @Volatile private var running = false
    private var thread: Thread? = null
    val payloadLog = StringBuilder()
    private var payloadsLogged = 0

    fun claimAll() {
        for (k in 0 until device.interfaceCount) {
            val intf = device.getInterface(k)
            val ok = conn.claimInterface(intf, true)
            log("claim interface ${intf.id} alt ${intf.alternateSetting} class ${intf.interfaceClass}/${intf.interfaceSubclass}: $ok")
            if (ok) claimed += intf
            for (e in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(e)
                if (intf.interfaceClass == 0x0e && intf.interfaceSubclass == 2 && ep.direction == UsbConstants.USB_DIR_IN &&
                    ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) bulkIn = ep
            }
        }
        log("streaming endpoint: " + (bulkIn?.let { String.format("0x%02x bulk, max packet %d", it.address, it.maxPacketSize) } ?: "none found"))
    }

    fun release() {
        stop()
        for (i in claimed) conn.releaseInterface(i)
        claimed.clear()
        conn.close()
    }

    // ---- control requests ----

    private fun get(request: Int, selector: Int, index: Int, len: Int): ByteArray? {
        val b = ByteArray(len)
        val n = conn.controlTransfer(0xA1, request, selector shl 8, index, b, len, 500)
        return if (n < 0) null else b.copyOf(n)
    }

    private fun set(selector: Int, index: Int, data: ByteArray): Int =
        conn.controlTransfer(0x21, 0x01, selector shl 8, index, data, data.size, 500)

    /** Reads (never writes) every control the units say they have: GET_INFO, GET_LEN, CUR, MIN, MAX, DEF, RES. */
    fun readAllControls(): String {
        val sb = StringBuilder()
        sb.append(String.format("UVC version %x.%02x, control interface %d, streaming interface %d\n",
            desc.bcdUvc shr 8, desc.bcdUvc and 0xff, desc.vcInterface, desc.vsInterface))
        for (u in desc.units) {
            sb.append("\n${u.kind} id ${u.id}")
            if (u.guid.isNotEmpty()) sb.append(" guid ${u.guid}")
            sb.append(" controls bitmap ${hex(u.controlBits)}\n  raw ${u.raw}\n")
            if (u.id < 0 || u.controlBits.isEmpty()) continue
            val index = (u.id shl 8) or desc.vcInterface
            val nSel = minOf(64, u.controlBits.size * 8)
            for (bit in 0 until nSel) {
                // extension units: probe every selector, a vendor's bitmap is not always honest; others: only set bits
                val has = (u8(u.controlBits, bit / 8) shr (bit % 8)) and 1 == 1
                if (!has && u.kind != "extension unit") continue
                val sel = bit + 1
                val info = get(0x86, sel, index, 1)
                val lenB = get(0x85, sel, index, 2)
                var len = if (lenB != null && lenB.size == 2) u16(lenB, 0) else 0
                if (u.kind != "extension unit" && len == 0) len = 8
                if (info == null && lenB == null && !has) continue
                sb.append("  selector $sel: info ${info?.let { hex(it) } ?: "-"} len ${lenB?.let { u16(it, 0).toString() } ?: "-"}")
                if (len in 1..1024) {
                    for ((name, req) in listOf("cur" to 0x81, "min" to 0x82, "max" to 0x83, "def" to 0x87, "res" to 0x84)) {
                        val v = get(req, sel, index, len)
                        sb.append(" $name ${v?.let { hex(it) } ?: "-"}")
                    }
                }
                sb.append("\n")
            }
        }
        return sb.toString()
    }

    /** CT_ZOOM_ABSOLUTE on the camera terminal: some thermal cores use it as a command channel. */
    fun cameraTerminalId(): Int = desc.units.firstOrNull { it.kind.startsWith("input terminal 0x0201") }?.id ?: 1

    fun setZoomAbsolute(value: Int): String {
        val index = (cameraTerminalId() shl 8) or desc.vcInterface
        val before = get(0x81, 0x0B, index, 2)
        val n = set(0x0B, index, byteArrayOf((value and 0xff).toByte(), ((value shr 8) and 0xff).toByte()))
        val after = get(0x81, 0x0B, index, 2)
        return String.format("zoom absolute <- 0x%04x: result %d, before %s, after %s", value, n,
            before?.let { hex(it) } ?: "-", after?.let { hex(it) } ?: "-")
    }

    // ---- choosing a stream ----

    fun commit(format: Int, frame: Int, interval: Long): Boolean {
        val vs = desc.vsInterface
        val lengths = when {
            desc.bcdUvc >= 0x0150 -> listOf(48, 34, 26)
            desc.bcdUvc >= 0x0110 -> listOf(34, 26, 48)
            else -> listOf(26, 34, 48)
        }
        var cur: ByteArray? = null
        for (l in lengths) { cur = get(0x81, 0x01, vs, l); if (cur != null && cur.size >= 26) { probeLen = l; break } }
        log("probe GET_CUR (len $probeLen): ${cur?.let { hex(it) } ?: "failed"}")
        val p = ByteArray(probeLen)
        if (cur != null) System.arraycopy(cur, 0, p, 0, minOf(cur.size, probeLen))
        p[0] = 1; p[1] = 0 // bmHint: keep the frame interval
        p[2] = format.toByte(); p[3] = frame.toByte()
        putU32(p, 4, interval)
        val s1 = set(0x01, vs, p)
        val got = get(0x81, 0x01, vs, probeLen)
        log("probe SET_CUR format $format frame $frame interval $interval: $s1; device answered ${got?.let { hex(it) } ?: "nothing"}")
        val c = got ?: p
        val s2 = set(0x02, vs, c)
        log("commit SET_CUR: $s2")
        if (s2 < 0) return false
        committed = c
        maxFrame = u32(c, 18)
        maxPayload = u32(c, 22)
        log("max frame $maxFrame bytes, max payload $maxPayload bytes")
        return true
    }

    // ---- streaming ----

    fun start(onFrame: (UvcFrameData) -> Unit) {
        val ep = bulkIn ?: run { log("no bulk endpoint, cannot stream"); return }
        stop()
        running = true
        payloadsLogged = 0
        thread = Thread {
            // exactly the payload size the camera promised: a read then ends at one payload even with no short packet
            val size = if (maxPayload in 1..(4L * 1024 * 1024)) maxPayload.toInt() else 65536
            val buf = ByteArray(size)
            var frame = java.io.ByteArrayOutputStream(maxOf(65536, maxFrame.toInt()))
            var lastFid = -1
            var pts = -1L
            var scr = ""
            var payloads = 0
            var errors = 0
            var timeouts = 0
            fun emit() {
                if (frame.size() > 0) onFrame(UvcFrameData(frame.toByteArray(), SystemClock.elapsedRealtimeNanos(), pts, scr, payloads, errors))
                frame = java.io.ByteArrayOutputStream(maxOf(65536, maxFrame.toInt()))
                payloads = 0; errors = 0
            }
            while (running) {
                val n = conn.bulkTransfer(ep, buf, buf.size, 1000)
                if (n < 0) {
                    timeouts++
                    if (timeouts == 1 || timeouts % 10 == 0) log("bulk read returned $n ($timeouts so far)")
                    continue
                }
                if (n == 0) continue
                if (payloadsLogged < 40) {
                    synchronized(payloadLog) {
                        payloadLog.append("payload ${payloadsLogged}: $n bytes, head ${hex(buf, 0, minOf(n, 48))}\n")
                    }
                    payloadsLogged++
                }
                val hl = u8(buf, 0)
                val info = u8(buf, 1)
                if (hl < 2 || hl > 12 || hl > n) { // no valid header: keep the bytes, say so once in a while
                    errors++
                    frame.write(buf, 0, n)
                    continue
                }
                val fid = info and 1
                if (lastFid >= 0 && fid != lastFid && frame.size() > 0) emit()
                lastFid = fid
                if (info and 0x04 != 0 && hl >= 6) pts = u32(buf, 2)
                if (info and 0x08 != 0 && hl >= 12) scr = hex(buf, hl - 6, 6)
                if (info and 0x40 != 0) errors++
                payloads++
                frame.write(buf, hl, n - hl)
                if (info and 0x02 != 0) emit()
            }
        }.also { it.name = "uvc-stream"; it.start() }
    }

    fun stop() {
        val t = thread ?: return
        running = false
        t.join(2000)
        thread = null
        bulkIn?.let { conn.controlTransfer(0x02, 0x01, 0, it.address, null, 0, 500) } // CLEAR_FEATURE(ENDPOINT_HALT)
    }
}
