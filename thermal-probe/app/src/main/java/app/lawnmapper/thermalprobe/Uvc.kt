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

    /*
     * THE SHUTTER (decoded from HIKMICRO's libusbCam_host.so hal_usbcam_host_shutter_ctrl and libhikdsp.so
     * ST_TurnOnShutter / ST_TurnOffShutter, 2026-11-13). A latching motor: a zero-length SET_CUR to the first
     * extension unit with the COMMAND IN wValue (not selector<<8): 9 drives it closed, 8 drives it open, and 10,
     * sent 140 ms later, releases the drive. It stays where it was left, which is why the first captures were of
     * the closed shutter.
     */
    fun xuCommand(value: Int): Int {
        val xu = desc.units.firstOrNull { it.kind == "extension unit" }?.id ?: 10
        return conn.controlTransfer(0x21, 0x01, value, (xu shl 8) or desc.vcInterface, null, 0, 200)
    }

    /** A vendor GET in the same style: wValue is the command number, as hal_usbcam_host_get_* send it. */
    fun xuGet(value: Int, len: Int): ByteArray? {
        val xu = desc.units.firstOrNull { it.kind == "extension unit" }?.id ?: 10
        val b = ByteArray(len)
        val n = conn.controlTransfer(0xA1, 0x81, value, (xu shl 8) or desc.vcInterface, b, len, 300)
        return if (n < 0) null else b.copyOf(n)
    }

    /** Everything the HAL's read commands give (numbers and lengths from libusbCam_host.so), for the log. */
    fun vendorInfo(): String {
        val sb = StringBuilder("vendor reads (command: bytes):\n")
        fun show(name: String, v: Int, len: Int) {
            val r = xuGet(v, len)
            val txt = r?.let { b -> String(b, Charsets.ISO_8859_1).filter { it.code in 32..126 } } ?: ""
            sb.append("  $name ($v, $len): ${r?.let { hex(it) } ?: "failed"}${if (txt.length >= 3) "  \"$txt\"" else ""}\n")
        }
        show("product info", 13, 64); show("mcu version", 14, 48); show("serial?", 16, 16); show("info 17", 17, 8)
        show("info 18", 18, 1); show("info 19", 19, 1); show("info 20", 20, 1); show("info 21", 21, 4)
        show("workmode", 22, 1); show("update state", 23, 4); show("error code", 24, 1); show("bld version", 25, 48)
        show("calib temp", 27, 4); show("rise-temp comp", 29, 40)
        val c = xuCommand(6) // cavity temperature: a set of 6, then a get of 5
        sb.append("  cavity temp request (6): $c\n")
        Thread.sleep(50)
        show("cavity temp", 5, 3); show("cavity temp (2)", 5, 2)
        return sb.toString()
    }

    /*
     * THE HIK DEVICECONFIG PROTOCOL on the extension unit (wIndex = unit 10 << 8 | interface 0 = 0x0A00), as
     * documented for the Topdon TC002C (a HIKMICRO-built camera) in github.com/3ricj/IRPanoView, MasterThermoDocs
     * 02 (transport), 03 (session bind) and 09 (shutter); written here from those facts, not copied. Channels are
     * wValue: 0x0500 select (2 bytes: phase, sub), 0x0100 misc, 0x0200 image, 0x0300 thermometry, 0x0400
     * version, 0x0600 command state (1 byte, 1 = idle), 0x1700 capabilities. Requests: 0x85 PROBE (IN, 4 bytes,
     * the first two a length), 0x81 GET (IN), 0x01 SET (OUT).
     */
    private fun xuIndex(): Int = ((desc.units.firstOrNull { it.kind == "extension unit" }?.id ?: 10) shl 8) or desc.vcInterface

    fun hikProbe(wv: Int): ByteArray? {
        val b = ByteArray(4)
        val n = conn.controlTransfer(0xA1, 0x85, wv, xuIndex(), b, 4, 500)
        return if (n < 0) null else b.copyOf(n)
    }

    fun hikGet(wv: Int, len: Int): ByteArray? {
        val b = ByteArray(len)
        val n = conn.controlTransfer(0xA1, 0x81, wv, xuIndex(), b, len, 1000)
        return if (n < 0) null else b.copyOf(n)
    }

    fun hikSet(wv: Int, data: ByteArray): Int {
        hikProbe(wv)
        return conn.controlTransfer(0x21, 0x01, wv, xuIndex(), data, data.size, 1000)
    }

    fun hikSelect(phase: Int, sub: Int): Int {
        hikProbe(0x0500)
        return conn.controlTransfer(0x21, 0x01, 0x0500, xuIndex(), byteArrayOf(phase.toByte(), sub.toByte()), 2, 1000)
    }

    fun hikState(): Int { hikProbe(0x0600); return hikGet(0x0600, 1)?.firstOrNull()?.toInt()?.and(0xff) ?: -1 }

    private fun probeLen(p: ByteArray?): Int = if (p != null && p.size >= 2) u16(p, 0) else -1

    /** The bind sequence (MasterThermoDocs 03, step 3), every answer logged. */
    fun hikBind(): String {
        val sb = StringBuilder("hik bind (wIndex 0x${Integer.toHexString(xuIndex())}):\n")
        fun show(name: String, b: ByteArray?) {
            val txt = b?.let { x -> String(x, Charsets.ISO_8859_1).filter { it.code in 32..126 } } ?: ""
            sb.append("  $name: ${b?.let { "${it.size} B ${hex(it, 0, minOf(it.size, 64))}" } ?: "failed"}${if (txt.length >= 4) "  \"${txt.take(80)}\"" else ""}\n")
        }
        // phase A: version, the select arm, short reads
        show("probe 0x0400", hikProbe(0x0400))
        show("version 0x0400", hikGet(0x0400, maxOf(1, minOf(64, probeLen(hikProbe(0x0400))))))
        sb.append("  arm select 02 00: ${hikSelect(0x02, 0x00)}\n")
        for (wv in listOf(0x0600, 0x0300, 0x0100)) {
            val pl = probeLen(hikProbe(wv))
            show(String.format("probe/get 0x%04x (probe len %d)", wv, pl), hikGet(wv, if (pl in 1..64) pl else 4))
        }
        // capability bursts, no select
        for (k in 0 until 4) {
            show("caps $k probe", hikProbe(0x1700)); show("caps $k head", hikGet(0x1700, 5))
            hikProbe(0x1700); show("caps $k body", hikGet(0x1700, 265))
        }
        // hardware server, device info, capability refresh
        sb.append("  select 01 04: ${hikSelect(0x01, 0x04)}\n"); hikProbe(0x0100); show("hardware server", hikGet(0x0100, 3))
        sb.append("  select 01 01: ${hikSelect(0x01, 0x01)}\n"); hikProbe(0x0100); show("device info", hikGet(0x0100, 488))
        sb.append("  select 17 1d: ${hikSelect(0x17, 0x1D)}\n")
        hikProbe(0x1700); show("caps head", hikGet(0x1700, 5)); hikProbe(0x1700); show("caps body", hikGet(0x1700, 265))
        sb.append("  command state: ${hikState()}\n")
        // hardware server again, polled (3 = ready)
        sb.append("  select 01 04: ${hikSelect(0x01, 0x04)}\n"); hikProbe(0x0100); show("hardware server", hikGet(0x0100, 3))
        return sb.toString()
    }

    /*
     * THE SK01'S SHUTTER (AY1 module, camera id 065356AA00), decoded 2026-11-13. HIKMICRO's driver
     * (libMicroDM AY1Version::setShutterControl(mode 1..3)) writes the mode into byte 0x5C of a cached
     * USB_IMAGE_ENHANCEMENT_EX and sends it: that byte is byBurnPreventionShutterControl (1 none, 2 close,
     * 3 open; only in manual mode). SET is command 2080 (route 02 05, channel 0x0200); libHCUSBSDK's
     * ConvertData packs the 516-byte struct into a 226-byte wire block in which 0x29 is
     * byBurnPreventionEnabled (0/1), 0x2A byBurnPreventionMode (1 auto, 2 manual), 0x2F the shutter control.
     * GET (2081) answers the same layout. So: read the block, change those three bytes, write it back.
     */
    fun enhRead(): ByteArray? {
        hikSelect(0x02, 0x05)
        val pl = probeLen(hikProbe(0x0200))
        return hikGet(0x0200, if (pl in 1..1024) pl else 226)
    }

    var lastEnh: ByteArray? = null

    fun sk01Shutter(control: Int): String {
        val r = enhRead()
        val buf = ByteArray(226)
        if (r != null && r.size >= 0x30) {
            System.arraycopy(r, 0, buf, 0, minOf(r.size, 226))
            if (lastEnh == null) lastEnh = r.copyOf()
        }
        val before = if (r != null && r.size > 0x2f) String.format("en %d mode %d ctl %d", r[0x29].toInt(), r[0x2a].toInt(), r[0x2f].toInt()) else "short read"
        buf[0x29] = 1; buf[0x2a] = 2; buf[0x2f] = control.toByte()
        val sel = hikSelect(0x02, 0x05)
        val set = hikSet(0x0200, buf)
        val states = mutableListOf<Int>()
        for (k in 0 until 10) { val st = hikState(); states += st; if (st == 1) break; Thread.sleep(100) }
        return "sk01 shutter control $control: read ${r?.size ?: -1} B ($before), select $sel, set $set, states $states"
    }

    /** Back to how the camera was: the block as first read, burn prevention as it was. */
    fun sk01Restore(): String {
        val r = lastEnh ?: return "nothing to restore"
        val buf = ByteArray(226); System.arraycopy(r, 0, buf, 0, minOf(r.size, 226))
        hikSelect(0x02, 0x05)
        return "sk01 restore: set ${hikSet(0x0200, buf)}, state ${hikState()}"
    }

    /*
     * CALIBRATION FILE DOWNLOAD (HIKMICRO USB_FileTransfer_V20 download, command 0x1F8; decoded from the
     * decompiled SDK 2026-11-14). Reads only: the two OUT packets on channel 0x1A00 only say which file to send.
     *   A: SELECT 1A 01; SET 0x1A00 "01 02 00 00 00" (padded to the probe length); SET 0x1A00
     *      "02 01 00 00 00 TT 01 00 00 00 00 00 00" (TT = file type); GET 0x0600 = 0 ok, 0x10 unsupported.
     *   B: SELECT 1A 02; GET 0x1A00 (probe length, 5): the size is the u32 at bytes 1-4.
     *   C: repeat GET 0x1A00 (probe length, at most 512) and keep bytes 5.. of each reply until size bytes.
     * Types: 11 KMatrix (256x192 u16 Q15 gain), 14 KMatrix2, 4 bad-pixel list (u32: col bits 0-11, row
     * 12-23, from 1), 5 vignetting (256x192 u16), 10 non-steady-state data.
     */
    private fun selectLen(phase: Int, sub: Int): Int {
        val pl = probeLen(hikProbe(0x0500)).let { if (it in 1..512) it else 2 }
        val d = ByteArray(pl); val full = byteArrayOf(phase.toByte(), sub.toByte(), 1, 0)
        System.arraycopy(full, 0, d, 0, minOf(pl, 4))
        return conn.controlTransfer(0x21, 0x01, 0x0500, xuIndex(), d, d.size, 5000)
    }

    private fun padTo(src: ByteArray, len: Int): ByteArray = if (len > src.size) src.copyOf(len) else src

    fun downloadFile(type: Int, log: StringBuilder): ByteArray? {
        val sa = selectLen(0x1A, 0x01)
        val p1 = probeLen(hikProbe(0x1A00))
        val s1 = conn.controlTransfer(0x21, 0x01, 0x1A00, xuIndex(), padTo(byteArrayOf(1, 2, 0, 0, 0), p1), maxOf(5, p1), 5000)
        val p2 = probeLen(hikProbe(0x1A00))
        val pkt = padTo(byteArrayOf(2, 1, 0, 0, 0, type.toByte(), 1, 0, 0, 0, 0, 0, 0), p2)
        val s2 = conn.controlTransfer(0x21, 0x01, 0x1A00, xuIndex(), pkt, pkt.size, 5000)
        hikProbe(0x0600)
        val st = hikGet(0x0600, 1)?.firstOrNull()?.toInt()?.and(0xff) ?: -1
        log.append("type $type: select 1A01 $sa, probe $p1, set1 $s1, probe $p2, set2 $s2 (${pkt.size} B), state $st\n")
        if (st == 0x10) { log.append("  unsupported\n"); return null }
        val sb = selectLen(0x1A, 0x02)
        val pb = probeLen(hikProbe(0x1A00)).let { if (it in 1..512) it else 5 }
        val sz = hikGet(0x1A00, pb)
        log.append("  select 1A02 $sb, probe $pb, size reply ${sz?.let { hex(it) } ?: "failed"}\n")
        if (sz == null || sz.size < 5) return null
        val size = u32(sz, 1).toInt()
        if (size <= 0 || size > 4 * 1024 * 1024) { log.append("  implausible size $size\n"); return null }
        val out = java.io.ByteArrayOutputStream(size)
        var chunks = 0
        while (out.size() < size && chunks < 20000) {
            val pl = probeLen(hikProbe(0x1A00)).let { if (it in 6..512) it else 512 }
            val c = hikGet(0x1A00, pl) ?: run { log.append("  chunk $chunks failed after ${out.size()} B\n"); return null }
            if (chunks < 3 || c.size <= 5) log.append("  chunk $chunks: ${c.size} B, head ${hex(c, 0, minOf(c.size, 12))}\n")
            if (c.size <= 5) { log.append("  empty chunk; stop\n"); break }
            out.write(c, 5, minOf(c.size - 5, size - out.size()))
            chunks++
        }
        log.append("  got ${out.size()} of $size B in $chunks chunks\n")
        return if (out.size() == size) out.toByteArray() else null
    }

    /** Manual shutter / one-shot NUC, control 0x7E9 (MasterThermoDocs 09): select 02 04, SET 0x0200 with
     *  USB_COMMON_COND (12 bytes: size 12, channel 1), then poll the command state until idle. */
    fun hikManualShutter(): String {
        val sel = hikSelect(0x02, 0x04)
        val cond = ByteArray(12).also { it[0] = 12; it[4] = 1 }
        val set = hikSet(0x0200, cond)
        val states = mutableListOf<Int>()
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) {
            val st = hikState(); states += st
            if (st == 1 && states.size > 1) break
            Thread.sleep(150)
        }
        return "hik manual shutter: select $sel, set $set, states $states"
    }

    /*
     * HIKMICRO's OWN PATH for the SK02 (VID 14526 / PID 388 go through com.guardexpert.microsensorsdk, which drives
     * the camera through libHCUSBSDK.so). USB_SET_IMAGE_MANUAL_CORRECT (command 2025, "one-touch manual
     * correction": the shutter closes, the reference is taken, it opens) is built by
     * CUsbCommandConfig<2025>::Excute -> DoUvcCommonExcuteImpl(0x200, 4, 1): a packet of an 8-byte setup
     * (21 01 .. .. 00 02 00 00) and 3 bytes (03 88 04); ProtocolStrategyUvc10 sends the 3 bytes as the data, and
     * CUsbDriverLibuvc::DoControlDataSyncDetached reads wValue from setup bytes 4-5 and wIndex from 6-7. So:
     * SET_CUR (0x21, 0x01), wValue 0x0200, wIndex 0, data 03 88 04. Decoded, not yet seen to work (2026-11-13).
     */
    fun manualCorrect(wIndex: Int): String {
        val data = byteArrayOf(0x03, 0x88.toByte(), 0x04)
        val n = conn.controlTransfer(0x21, 0x01, 0x0200, wIndex, data, data.size, 2000)
        return String.format("manual correct (wValue 0x0200, wIndex 0x%04x, data 038804): %d", wIndex, n)
    }

    fun shutter(open: Boolean): String {
        val a = xuCommand(if (open) 8 else 9)
        Thread.sleep(140)
        val b = xuCommand(10)
        return "shutter ${if (open) "open (8)" else "close (9)"}: $a, release (10): $b"
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
                // the SK02's headers are 16 bytes (2 standard + 14 of its own), more than the usual 12: any length the
                // transfer can hold is accepted, with the end-of-header bit (0x80) as the check
                if (hl < 2 || hl > n || info and 0x80 == 0) { // no valid header: keep the bytes
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
                // never grow without bound (the first build did, and ran out of memory): a frame past twice the
                // promised size is cut and passed on as it is
                if (maxFrame > 0 && frame.size() > 2 * maxFrame) { log("frame overran ${frame.size()} bytes; cut"); emit() }
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
