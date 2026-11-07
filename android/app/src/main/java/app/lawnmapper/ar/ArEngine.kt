package app.lawnmapper.ar

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.view.Surface
import com.google.ar.core.Coordinates2d
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import java.nio.ByteOrder
import java.util.concurrent.Executors
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.roundToInt

/**
 * The GL thread: ARCore's frame, the camera drawn behind the page, and what the page asks for, kept ready (the page's
 * calls arrive on another thread, so they read copies made here). What the page can tune comes in Options, from the
 * page itself, so a tweak is a site deploy.
 */
class ArEngine(private val send: (String) -> Unit) : GLSurfaceView.Renderer {

    class Options(
        var grabW: Int = 480, var jpegQ: Int = 80, var near: Float = 0.05f, var far: Float = 300f,
        var depthEveryMs: Long = 200, var pictureEveryMs: Long = 700, var geoEveryMs: Long = 1000,
    )

    @Volatile var session: Session? = null
    @Volatile var options = Options()
    @Volatile var crossX = 0.5f
    @Volatile var crossY = 0.5f
    @Volatile var depthRaw: DepthSnapshot? = null
    @Volatile var depthSmooth: DepthSnapshot? = null
    // the raw depth image's own time: ARCore does not make new raw depth every frame, and a repeat is the last depth
    // reprojected (developers.google.com/ar/develop/java/depth/raw-depth), so a repeat is not kept as a new picture
    private var lastRawImageTs = 0L
    @Volatile var picture: Picture? = null
    @Volatile var geoOn = false
    @Volatile private var inFlight = false

    private val bg = BackgroundRenderer()
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var pictureBusy = false
    private var textureFor: Session? = null
    private var geometryFor: Session? = null
    private var viewW = 1
    private var viewH = 1
    private var lastTs = 0L
    private var lastDepth = 0L
    private var lastPicture = 0L
    private var lastGeo = 0L
    private var geoJson: String? = null
    private val view = FloatArray(16)
    private val proj = FloatArray(16)

    fun delivered() { inFlight = false }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        bg.create()
        textureFor = null
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        viewW = width; viewH = height
        geometryFor = null
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val s = session ?: return
        if (textureFor !== s) { s.setCameraTextureName(bg.textureId); textureFor = s }
        if (geometryFor !== s) { s.setDisplayGeometry(Surface.ROTATION_0, viewW, viewH); geometryFor = s }
        val frame = try { s.update() } catch (e: Exception) { return }
        bg.draw(frame)
        val ts = frame.timestamp
        if (ts == 0L || ts == lastTs) return
        lastTs = ts
        val cam = frame.camera
        val tracking = cam.trackingState == TrackingState.TRACKING
        val now = System.currentTimeMillis()
        if (tracking && now - lastDepth >= options.depthEveryMs) { lastDepth = now; snapDepth(frame) }
        if (tracking && !pictureBusy && now - lastPicture >= options.pictureEveryMs) { lastPicture = now; snapPicture(frame) }
        if (geoOn && now - lastGeo >= options.geoEveryMs) { lastGeo = now; geoJson = geo(s) }
        if (inFlight) return
        inFlight = true
        send(frameJson(frame, tracking))
    }

    /** One frame for the page: the display's camera pose, view and projection, the crosshair's hit, ARCore's state. */
    private fun frameJson(frame: Frame, tracking: Boolean): String {
        val cam = frame.camera
        val sb = StringBuilder(900)
        sb.append("{\"t\":").append(frame.timestamp / 1e6)
        sb.append(",\"w\":").append(viewW).append(",\"h\":").append(viewH)
        sb.append(",\"tracking\":\"").append(if (tracking) "normal" else "lost").append('"')
        if (!tracking) sb.append(",\"reason\":\"").append(cam.trackingFailureReason.name).append('"')
        if (tracking) {
            val p = cam.displayOrientedPose
            sb.append(",\"pose\":{\"p\":[").append(r3(p.tx())).append(',').append(r3(p.ty())).append(',').append(r3(p.tz()))
            sb.append("],\"q\":[").append(p.qx()).append(',').append(p.qy()).append(',').append(p.qz()).append(',').append(p.qw()).append("]}")
            cam.getViewMatrix(view, 0)
            cam.getProjectionMatrix(proj, 0, options.near, options.far)
            sb.append(",\"view\":").append(Picture.arr(view)).append(",\"proj\":").append(Picture.arr(proj))
            hit(frame)?.let { sb.append(",\"hit\":").append(it) }
        }
        sb.append(",\"depth\":").append(depthRaw != null || depthSmooth != null)
        geoJson?.let { sb.append(",\"geo\":").append(it); geoJson = null }
        sb.append('}')
        return sb.toString()
    }

    /** What is under the crosshair: ARCore's depth first, then a found surface, then a tracked feature point. */
    private fun hit(frame: Frame): String? {
        val cam = frame.camera.pose
        for (h in frame.hitTest(crossX * viewW, crossY * viewH)) {
            val tr = h.trackable
            val type = when {
                tr is DepthPoint -> "DEPTH"
                tr is Plane && tr.isPoseInPolygon(h.hitPose) -> "SURFACE"
                tr is Point -> "FEATURE_POINT"
                else -> null
            } ?: continue
            val p = h.hitPose
            val d = Math.hypot(Math.hypot((p.tx() - cam.tx()).toDouble(), (p.ty() - cam.ty()).toDouble()), (p.tz() - cam.tz()).toDouble())
            return "{\"p\":[${r3(p.tx())},${r3(p.ty())},${r3(p.tz())}],\"type\":\"$type\",\"d\":${r3(d.toFloat())}}"
        }
        return null
    }

    private fun screenTo(frame: Frame, to: Coordinates2d): Affine {
        val out = FloatArray(6)
        frame.transformCoordinates2d(Coordinates2d.VIEW_NORMALIZED, floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f), to, out)
        return Affine.of(out)
    }

    private fun snapDepth(frame: Frame) {
        val cam = frame.camera
        val pose = FloatArray(16).also { cam.pose.toMatrix(it, 0) }
        val k = cam.textureIntrinsics
        val dims = k.imageDimensions
        val f = k.focalLength
        val c = k.principalPoint
        val map = screenTo(frame, Coordinates2d.TEXTURE_NORMALIZED)
        val t = frame.timestamp / 1e6
        fun make(kind: String, img: android.media.Image, confImg: android.media.Image?): DepthSnapshot {
            val w = img.width; val h = img.height
            val plane = img.planes[0]
            val sb = plane.buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val rowShorts = plane.rowStride / 2
            val mm = ShortArray(w * h)
            for (y in 0 until h) { sb.position(y * rowShorts); sb.get(mm, y * w, w) }
            var conf: ByteArray? = null
            if (confImg != null) {
                val cp = confImg.planes[0]
                val cb = cp.buffer
                conf = ByteArray(w * h)
                for (y in 0 until h) { cb.position(y * cp.rowStride); cb.get(conf, y * w, w) }
            }
            val sx = w.toFloat() / dims[0]; val sy = h.toFloat() / dims[1]
            return DepthSnapshot(kind, w, h, mm, conf, f[0] * sx, f[1] * sy, c[0] * sx, c[1] * sy, pose, map, t)
        }
        var raw = false
        try {
            frame.acquireRawDepthImage16Bits().use { img ->
                raw = true
                if (img.timestamp != lastRawImageTs) {
                    lastRawImageTs = img.timestamp
                    frame.acquireRawDepthConfidenceImage().use { ci -> depthRaw = make("raw", img, ci) }
                }
            }
        } catch (_: Exception) { }
        // the smoothed depth only where there is no raw (the page uses raw when it has it)
        if (!raw) try {
            frame.acquireDepthImage16Bits().use { img -> depthSmooth = make("smooth", img, null) }
        } catch (_: Exception) { }
    }

    private fun snapPicture(frame: Frame) {
        val o = options
        val raw = try {
            frame.acquireCameraImage().use { img ->
                val yp = img.planes[0]; val up = img.planes[1]; val vp = img.planes[2]
                fun bytes(b: java.nio.ByteBuffer) = ByteArray(b.remaining()).also { b.get(it) }
                val cam = frame.camera
                val v = FloatArray(16).also { cam.getViewMatrix(it, 0) }
                val p = FloatArray(16).also { cam.getProjectionMatrix(it, 0, o.near, o.far) }
                val outW = o.grabW
                val outH = (outW.toFloat() * viewH / viewW).roundToInt()
                RawPicture(bytes(yp.buffer), bytes(up.buffer), bytes(vp.buffer), yp.rowStride, up.rowStride, up.pixelStride,
                    img.width, img.height, screenTo(frame, Coordinates2d.IMAGE_NORMALIZED), outW, outH, v, p, frame.timestamp / 1e6)
            }
        } catch (_: Exception) { return }
        pictureBusy = true
        worker.execute {
            try { picture = Picture.from(raw, o.jpegQ) } catch (_: Exception) { } finally { pictureBusy = false }
        }
    }

    /** ARCore's Geospatial pose (Street View's localisation), when the build has a key and Earth is tracking. */
    private fun geo(s: Session): String? {
        val earth = s.earth ?: return null
        if (earth.trackingState != TrackingState.TRACKING) return "{\"state\":\"${earth.earthState.name}\"}"
        val g = earth.cameraGeospatialPose
        val q = g.eastUpSouthQuaternion
        return "{\"state\":\"ENABLED\",\"lat\":${g.latitude},\"lng\":${g.longitude},\"alt\":${r3(g.altitude.toFloat())}," +
            "\"hacc\":${r3(g.horizontalAccuracy.toFloat())},\"vacc\":${r3(g.verticalAccuracy.toFloat())}," +
            "\"yawAcc\":${r3(g.orientationYawAccuracy.toFloat())},\"eus\":[${q[0]},${q[1]},${q[2]},${q[3]}]}"
    }
}
