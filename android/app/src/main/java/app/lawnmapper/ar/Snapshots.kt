package app.lawnmapper.ar

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Three decimals, whatever the phone's language (a comma would break the JSON). */
fun r3(x: Float): String = (Math.round(x * 1000.0) / 1000.0).toString()

/**
 * A map from the screen (VIEW_NORMALIZED: 0..1 across, 0..1 down, as the page sees it) to an image's own normalized
 * coordinates, from where ARCore puts three corners. ARCore's mapping is a rotation, a scale and a crop: affine.
 */
class Affine(val ox: Float, val oy: Float, val ux: Float, val uy: Float, val vx: Float, val vy: Float) {
    fun s(u: Float, v: Float) = ox + u * ux + v * vx
    fun t(u: Float, v: Float) = oy + u * uy + v * vy

    companion object {
        /** From the three mapped corners [x0,y0 (0,0), x1,y1 (1,0), x2,y2 (0,1)]. */
        fun of(c: FloatArray) = Affine(c[0], c[1], c[2] - c[0], c[3] - c[1], c[4] - c[0], c[5] - c[1])
    }
}

/**
 * One depth picture, copied off the frame: millimetres (0 = no depth there) and, for raw depth, ARCore's confidence
 * (0..255), with what turns a pixel into a point in the world: the camera's intrinsics in depth pixels, the camera's
 * pose then (column-major 4x4) and the screen-to-depth map.
 */
class DepthSnapshot(
    val kind: String, val w: Int, val h: Int, val mm: ShortArray, val conf: ByteArray?,
    val fx: Float, val fy: Float, val cx: Float, val cy: Float, val pose: FloatArray, val map: Affine, val t: Double,
) {
    /**
     * A grid over the screen, nx across and ny down, row by row: each cell's world point (or null where there is no
     * depth or the confidence is under minConf), its depth in metres as given (0 = a hole) and its confidence.
     */
    fun gridJson(nx: Int, ny: Int, minConf: Int): String {
        val p = StringBuilder(nx * ny * 24)
        val d = StringBuilder(nx * ny * 6)
        val c = StringBuilder(nx * ny * 4)
        var holes = 0
        for (j in 0 until ny) for (i in 0 until nx) {
            val u = (i + 0.5f) / nx
            val v = (j + 0.5f) / ny
            val px = map.s(u, v) * w
            val py = map.t(u, v) * h
            val ix = min(w - 1, max(0, floor(px).toInt()))
            val iy = min(h - 1, max(0, floor(py).toInt()))
            val k = iy * w + ix
            val z = (mm[k].toInt() and 0xFFFF) / 1000f
            val cf = if (conf != null) (conf[k].toInt() and 0xFF) else 255
            if (p.isNotEmpty()) { p.append(','); d.append(','); c.append(',') }
            d.append(if (z > 0f) r3(z) else "0")
            c.append(cf)
            if (z <= 0f) holes++
            if (z <= 0f || cf < minConf) { p.append("null,null,null"); continue }
            val x = (px - cx) / fx * z
            val y = (py - cy) / fy * z
            // the camera looks down -Z with +Y up; the picture's rows run down
            val ax = x; val ay = -y; val az = -z
            val wx = pose[0] * ax + pose[4] * ay + pose[8] * az + pose[12]
            val wy = pose[1] * ax + pose[5] * ay + pose[9] * az + pose[13]
            val wz = pose[2] * ax + pose[6] * ay + pose[10] * az + pose[14]
            p.append(r3(wx)).append(',').append(r3(wy)).append(',').append(r3(wz))
        }
        return "{\"kind\":\"$kind\",\"nx\":$nx,\"ny\":$ny,\"w\":$w,\"h\":$h,\"t\":$t,\"holes\":$holes,\"p\":[$p],\"d\":[$d],\"c\":[$c]}"
    }
}

/** A camera picture's planes, copied off the frame, waiting to be turned into what the page wants. */
class RawPicture(
    val y: ByteArray, val u: ByteArray, val v: ByteArray, val yRow: Int, val uvRow: Int, val uvPix: Int,
    val imgW: Int, val imgH: Int, val map: Affine, val outW: Int, val outH: Int,
    val view: FloatArray, val proj: FloatArray, val t: Double,
)

/** The picture as the page wants it: the screen's view of the camera, RGBA rows from the top, and the same as a JPEG. */
class Picture(val w: Int, val h: Int, val rgba: ByteArray, val jpeg: ByteArray, val view: FloatArray, val proj: FloatArray, val t: Double) {
    fun json(): String {
        val sb = StringBuilder(rgba.size * 4 / 3 + jpeg.size * 4 / 3 + 600)
        sb.append("{\"w\":").append(w).append(",\"h\":").append(h).append(",\"t\":").append(t)
        sb.append(",\"view\":").append(arr(view)).append(",\"proj\":").append(arr(proj))
        sb.append(",\"rgba\":\"").append(Base64.encodeToString(rgba, Base64.NO_WRAP)).append('"')
        sb.append(",\"jpeg\":\"").append(Base64.encodeToString(jpeg, Base64.NO_WRAP)).append("\"}")
        return sb.toString()
    }

    companion object {
        fun arr(a: FloatArray) = a.joinToString(",", "[", "]") { (Math.round(it * 1e6) / 1e6).toString() }

        /** YUV (BT.601, full range) sampled through the screen-to-image map, nearest pixel. */
        fun from(r: RawPicture, quality: Int): Picture {
            val n = r.outW * r.outH
            val rgba = ByteArray(n * 4)
            val argb = IntArray(n)
            for (oy in 0 until r.outH) for (ox in 0 until r.outW) {
                val su = (ox + 0.5f) / r.outW
                val sv = (oy + 0.5f) / r.outH
                val px = min(r.imgW - 1, max(0, (r.map.s(su, sv) * r.imgW).toInt()))
                val py = min(r.imgH - 1, max(0, (r.map.t(su, sv) * r.imgH).toInt()))
                val yy = (r.y[py * r.yRow + px].toInt() and 0xFF).toFloat()
                val ci = (py / 2) * r.uvRow + (px / 2) * r.uvPix
                val uu = (r.u[min(ci, r.u.size - 1)].toInt() and 0xFF) - 128f
                val vv = (r.v[min(ci, r.v.size - 1)].toInt() and 0xFF) - 128f
                val red = clamp(yy + 1.402f * vv)
                val green = clamp(yy - 0.344136f * uu - 0.714136f * vv)
                val blue = clamp(yy + 1.772f * uu)
                val k = oy * r.outW + ox
                rgba[k * 4] = red.toByte(); rgba[k * 4 + 1] = green.toByte(); rgba[k * 4 + 2] = blue.toByte(); rgba[k * 4 + 3] = 255.toByte()
                argb[k] = (0xFF shl 24) or (red shl 16) or (green shl 8) or blue
            }
            val bmp = Bitmap.createBitmap(argb, r.outW, r.outH, Bitmap.Config.ARGB_8888)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
            bmp.recycle()
            return Picture(r.outW, r.outH, rgba, out.toByteArray(), r.view, r.proj, r.t)
        }

        private fun clamp(x: Float): Int = min(255, max(0, x.roundToInt()))
    }
}
