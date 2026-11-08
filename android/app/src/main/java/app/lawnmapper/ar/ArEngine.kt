package app.lawnmapper.ar

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.view.Surface
import com.google.ar.core.Anchor
import com.google.ar.core.Coordinates2d
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Pose
import com.google.ar.core.SemanticLabel
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import com.google.ar.core.PlaybackStatus
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
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
        var semEveryMs: Long = 500, var anchorsEveryMs: Long = 1000,
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
    // ARCore's Scene Semantics (bridge 2): a label for each pixel of an outdoor picture, read with the depth
    @Volatile var semOn = false
    @Volatile private var inFlight = false

    /* RECORDING AND REPLAY (bridge 3): while ARCore records, what the page does (a check mark, a pin) goes into the
       recording as a data track beside the camera, with the frame it happened on; on a replay those come back with
       the same frames ("events" in the frame), so the page can do them again. */
    @Volatile var recording = false
    @Volatile var bothDepths = false
    @Volatile var playback = false
    @Volatile var onPlaybackEnd: ((String) -> Unit)? = null
    private val toRecord = ConcurrentLinkedQueue<String>()
    private val replayed = StringBuilder()
    private var playbackEnded = false
    fun record(json: String) { if (recording) toRecord.add(json) }

    /* ANCHORS (bridge 2): the page asks for one at a session point and gets its id at once; it is made on this thread
       with the next frame, and every anchorsEveryMs the frame carries where ARCore now puts each one. ARCore moves an
       anchor when it corrects its own map, so the moves are its drift, admitted. */
    private val anchors = ConcurrentHashMap<Int, Anchor>()
    private val anchorAsks = ConcurrentLinkedQueue<Pair<Int, FloatArray>>()
    private val anchorDrops = ConcurrentLinkedQueue<Int>()
    private val nextAnchor = AtomicInteger(1)
    private var lastAnchors = 0L
    private var lastSem = 0L
    private var semJson: String? = null
    private var anchorsJson: String? = null

    /** An anchor asked for at a session point; its id, or -1 when too many are held (the page drops old ones). */
    fun askAnchor(x: Float, y: Float, z: Float): Int {
        if (anchors.size + anchorAsks.size >= MAX_ANCHORS) return -1
        val id = nextAnchor.getAndIncrement()
        anchorAsks.add(id to floatArrayOf(x, y, z))
        return id
    }
    fun dropAnchor(id: Int) { anchorDrops.add(id) }
    /** A new session: the old one's anchors died with it. */
    fun reset() { anchors.clear(); anchorAsks.clear(); anchorDrops.clear(); lastRawImageTs = 0L; depthRaw = null; depthSmooth = null; toRecord.clear(); replayed.setLength(0); playbackEnded = false }

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
        if (recording) while (true) { val j = toRecord.poll() ?: break; try { frame.recordTrackData(TRACK, ByteBuffer.wrap(j.toByteArray())) } catch (_: Exception) { } }
        if (playback) {
            try {
                for (d in frame.getUpdatedTrackData(TRACK)) {
                    val b = d.data; val bytes = ByteArray(b.remaining()); b.get(bytes)
                    if (replayed.isNotEmpty()) replayed.append(',')
                    replayed.append(String(bytes))
                }
            } catch (_: Exception) { }
            val ps = try { s.playbackStatus } catch (_: Exception) { PlaybackStatus.OK }
            if (!playbackEnded && ps != PlaybackStatus.OK && ps != PlaybackStatus.NONE) { playbackEnded = true; onPlaybackEnd?.invoke(ps.name) }
        }
        val ts = frame.timestamp
        if (ts == 0L || ts == lastTs) return
        lastTs = ts
        val cam = frame.camera
        val tracking = cam.trackingState == TrackingState.TRACKING
        val now = System.currentTimeMillis()
        if (tracking && now - lastDepth >= options.depthEveryMs) { lastDepth = now; snapDepth(frame) }
        if (tracking && !pictureBusy && now - lastPicture >= options.pictureEveryMs) { lastPicture = now; snapPicture(frame) }
        if (geoOn && now - lastGeo >= options.geoEveryMs) { lastGeo = now; geoJson = geo(s) }
        if (semOn && now - lastSem >= options.semEveryMs) { lastSem = now; semJson = semShares(frame) }
        if (tracking) anchorWork(s)
        if ((anchors.isNotEmpty()) && now - lastAnchors >= options.anchorsEveryMs) { lastAnchors = now; anchorsJson = anchorPoses() }
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
        semJson?.let { sb.append(",\"sem\":").append(it); semJson = null }
        anchorsJson?.let { sb.append(",\"anchors\":").append(it); anchorsJson = null }
        if (replayed.isNotEmpty()) { sb.append(",\"events\":[").append(replayed).append(']'); replayed.setLength(0) }
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
            return DepthSnapshot(kind, w, h, mm, conf, f[0] * sx, f[1] * sy, c[0] * sx, c[1] * sy, pose, map, t, if (semOn) semantics(frame) else null)
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
        // the smoothed depth only where there is no raw (the page uses raw when it has it), or always when Geospatial
        // Depth is on (bridge 3): that one reaches 65 m from Google's Streetscape Geometry, where raw stops
        if (!raw || bothDepths) try {
            frame.acquireDepthImage16Bits().use { img -> depthSmooth = make("smooth", img, null) }
        } catch (_: Exception) { }
    }

    /** The frame's semantic labels and their confidence, copied off (256 wide; ARCore's own label numbers 0..11). */
    private fun semantics(frame: Frame): SemImage? = try {
        frame.acquireSemanticImage().use { img ->
            frame.acquireSemanticConfidenceImage().use { ci ->
                val w = img.width; val h = img.height
                fun copy(im: android.media.Image): ByteArray {
                    val pl = im.planes[0]; val b = pl.buffer; val out = ByteArray(w * h)
                    for (y in 0 until h) { b.position(y * pl.rowStride); b.get(out, y * w, w) }
                    return out
                }
                SemImage(w, h, copy(img), copy(ci))
            }
        }
    } catch (_: Exception) { null }

    /** The share of the latest semantic picture under each label that matters here. */
    private fun semShares(frame: Frame): String? = try {
        val sb = StringBuilder("{")
        for ((k, l) in SEM_LABELS) {
            if (sb.length > 1) sb.append(',')
            sb.append('"').append(k).append("\":").append(r3(frame.getSemanticLabelFraction(l)))
        }
        sb.append('}').toString()
    } catch (_: Exception) { null }

    /** The anchors asked for and dropped since the last frame (here, on the GL thread, where ARCore wants them). */
    private fun anchorWork(s: Session) {
        while (true) {
            val (id, p) = anchorAsks.poll() ?: break
            try { anchors[id] = s.createAnchor(Pose.makeTranslation(p[0], p[1], p[2])) } catch (_: Exception) { }
        }
        while (true) {
            val id = anchorDrops.poll() ?: break
            anchors.remove(id)?.let { try { it.detach() } catch (_: Exception) { } }
        }
    }

    /** [[id, x, y, z, state], ...]: state 0 tracking, 1 paused, 2 stopped for good. */
    private fun anchorPoses(): String {
        val sb = StringBuilder("[")
        for ((id, a) in anchors) {
            val p = a.pose
            val st = when (a.trackingState) { TrackingState.TRACKING -> 0; TrackingState.PAUSED -> 1; else -> 2 }
            if (sb.length > 1) sb.append(',')
            sb.append('[').append(id).append(',').append(r3(p.tx())).append(',').append(r3(p.ty())).append(',').append(r3(p.tz())).append(',').append(st).append(']')
        }
        return sb.append(']').toString()
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

    companion object {
        const val MAX_ANCHORS = 64
        /** The page's own track in a recording (its actions, as JSON, with their frames). */
        val TRACK: UUID = UUID.fromString("5b0f3a1e-6c2d-4c4e-9a57-1a2b3c4d5e6f")
        val SEM_LABELS = listOf(
            "sky" to SemanticLabel.SKY, "building" to SemanticLabel.BUILDING, "tree" to SemanticLabel.TREE,
            "road" to SemanticLabel.ROAD, "sidewalk" to SemanticLabel.SIDEWALK, "terrain" to SemanticLabel.TERRAIN,
            "structure" to SemanticLabel.STRUCTURE, "object" to SemanticLabel.OBJECT, "vehicle" to SemanticLabel.VEHICLE,
            "person" to SemanticLabel.PERSON,
        )
    }
}
