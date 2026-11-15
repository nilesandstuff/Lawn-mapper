package app.lawnmapper.ar.thermal

import app.lawnmapper.thermalprobe.UvcFrameData
import com.google.ar.core.Pose
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.zip.Deflater

/**
 * DEV ONLY -- A WALK'S THERMAL FRAMES ON THE PHONE (src/dev/README.md has the format in full). One file per walk,
 * thermal/walks/<walk>.bin: "LMTH", a version byte, then records, each [kind u8][length u32][payload], little-endian.
 *
 *   'J'  a JSON note: start, setup, range, ref, sky, sweep, unplug, end
 *   'F'  a frame, a 38-byte head then its bytes: type u8 (0 scene, 1 shutter reference, 2 sky, 3 sweep, 4 shutter
 *        closed or moving), packing u8 (1 = deflate; 2 = each 16-bit number minus the same number of the frame named
 *        as base, modulo 65536, then deflate), width u16, rows u16, sequence u32, reference index u32, base frame's
 *        sequence u32 (0: none), time i64 (elapsedRealtimeNanos), UVC pts i64, payloads u16, errors u16. The bytes:
 *        the camera's raw 16-bit numbers, rows 0-216 and columns 0-259, row after row, little-endian.
 *   'P'  ARCore's camera pose at one ARCore frame: ARCore timestamp i64 (ns), elapsedRealtimeNanos i64 read beside
 *        it, position x y z f32 (metres, ARCore's world, y up), rotation quaternion x y z w f32, tracking u8.
 *
 * Written by a thread of its own so the USB reader never waits for the disk; a frame that finds the queue full is
 * dropped and counted.
 */
class ThermalFile(val file: File) {
    private class Rec(val kind: Int, val head: ByteArray?, val body: ByteArray, val pack: Boolean)
    private val queue = LinkedBlockingQueue<Rec>(150)
    private val out = BufferedOutputStream(FileOutputStream(file), 1 shl 16)
    @Volatile var frames = 0; private set
    @Volatile var poses = 0; private set
    @Volatile var dropped = 0; private set
    @Volatile var bytes = 0L; private set
    @Volatile private var open = true
    @Volatile private var done: (() -> Unit)? = null
    private val END = Rec(0, null, ByteArray(0), false)

    private val writer = Thread {
        val deflater = Deflater(Deflater.BEST_SPEED)
        val buf = ByteArray(1 shl 18)
        try {
            out.write("LMTH".toByteArray()); out.write(1)
            bytes = 5
            while (true) {
                val r = queue.take()
                if (r === END) break
                var body = r.body; var len = body.size
                if (r.pack) {
                    deflater.reset(); deflater.setInput(r.body); deflater.finish()
                    val packed = java.io.ByteArrayOutputStream(r.body.size / 2)
                    while (!deflater.finished()) { val n = deflater.deflate(buf); packed.write(buf, 0, n) }
                    body = packed.toByteArray(); len = body.size
                }
                val headLen = r.head?.size ?: 0
                val lead = ByteBuffer.allocate(5).order(ByteOrder.LITTLE_ENDIAN).put(r.kind.toByte()).putInt(headLen + len).array()
                out.write(lead); if (r.head != null) out.write(r.head); out.write(body, 0, len)
                bytes += 5 + headLen + len
                if (r.kind == 'J'.code) out.flush()
            }
        } catch (e: Exception) { android.util.Log.w("LawnAR", "thermal file: ${e.message}") } finally {
            try { out.close() } catch (_: Exception) {}
            deflater.end()
            done?.invoke()
        }
    }.apply { name = "thermal-file"; start() }

    fun json(o: JSONObject) {
        if (!open) return
        try { queue.put(Rec('J'.code, null, o.toString().toByteArray(), false)) } catch (_: InterruptedException) {}
    }

    /** True when the frame was taken (false: the queue was full and it was dropped). */
    fun frame(type: Int, seq: Int, ref: Int, baseSeq: Int, body: ByteArray, fd: UvcFrameData, width: Int, rows: Int): Boolean {
        if (!open) return false
        val head = ByteBuffer.allocate(38).order(ByteOrder.LITTLE_ENDIAN)
            .put(type.toByte()).put((if (baseSeq != 0) 2 else 1).toByte()).putShort(width.toShort()).putShort(rows.toShort())
            .putInt(seq).putInt(ref).putInt(baseSeq).putLong(fd.tNanos).putLong(fd.pts)
            .putShort(minOf(fd.payloads, 65535).toShort()).putShort(minOf(fd.errors, 65535).toShort()).array()
        return if (queue.offer(Rec('F'.code, head, body, true))) { frames++; true } else { dropped++; false }
    }

    fun pose(arNs: Long, elapsedNs: Long, p: Pose, tracking: Boolean) {
        if (!open) return
        val body = ByteBuffer.allocate(45).order(ByteOrder.LITTLE_ENDIAN).putLong(arNs).putLong(elapsedNs)
            .putFloat(p.tx()).putFloat(p.ty()).putFloat(p.tz()).putFloat(p.qx()).putFloat(p.qy()).putFloat(p.qz()).putFloat(p.qw())
            .put((if (tracking) 1 else 0).toByte()).array()
        if (queue.offer(Rec('P'.code, null, body, false))) poses++
    }

    /** No more records; then() once the file is whole on the disk. */
    fun close(then: () -> Unit) {
        if (!open) return
        open = false
        done = then
        try { queue.put(END) } catch (_: InterruptedException) {}
    }
}
