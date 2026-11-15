package app.lawnmapper.thermalprobe

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/*
 * ONE STILL FROM THE PHONE'S MAIN BACK CAMERA, for aligning the thermal camera to it (2026-11-14).
 * Focus is fixed at the hyperfocal distance with autofocus off, as ARCore keeps it by default, so the lens
 * geometry matches what the AR app sees. The JPEG is saved with a JSON of what the camera reports about itself
 * (intrinsics, distortion, lens pose, sensor sizes, the size used, the focus distance, the capture time on the
 * elapsedRealtime clock the thermal frames also use).
 */
class PhoneCamera(private val ctx: Context, private val log: (String) -> Unit) {

    private fun mainBackCamera(cm: CameraManager): String? {
        val backs = cm.cameraIdList.filter { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
        // the main camera is normally "0"; otherwise the back camera whose focal length is closest to ~4-6 mm wide
        return backs.firstOrNull { it == "0" } ?: backs.firstOrNull()
    }

    /** Takes one still; returns the elapsedRealtime (ns) of the exposure, or null. Blocks up to ~8 s. */
    fun still(jpg: File, meta: File): Long? {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = mainBackCamera(cm) ?: run { log("no back camera"); return null }
        val ch = cm.getCameraCharacteristics(id)
        val sizes = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!.getOutputSizes(ImageFormat.JPEG)
        // a 4:3 size near 2 MP keeps the files small and the full field of view (4:3 is the sensor's shape)
        val size = sizes.filter { it.width * 3 == it.height * 4 }.minByOrNull { Math.abs(it.width * it.height - 2_000_000) } ?: sizes.maxByOrNull { it.width * it.height }!!
        val thread = HandlerThread("phone-camera").apply { start() }
        val handler = Handler(thread.looper)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        val done = CountDownLatch(1)
        var sensorTs = 0L
        var device: CameraDevice? = null
        reader.setOnImageAvailableListener({ r ->
            r.acquireLatestImage()?.use { img ->
                val buf = img.planes[0].buffer; val bytes = ByteArray(buf.remaining()); buf.get(bytes)
                jpg.writeBytes(bytes)
            }
            done.countDown()
        }, handler)
        val hyper = ch.get(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE) ?: 0f
        try {
            val opened = CountDownLatch(1)
            @Suppress("MissingPermission")
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) { device = d; opened.countDown() }
                override fun onDisconnected(d: CameraDevice) { d.close(); opened.countDown() }
                override fun onError(d: CameraDevice, e: Int) { log("phone camera error $e"); d.close(); opened.countDown() }
            }, handler)
            if (!opened.await(4, TimeUnit.SECONDS) || device == null) { log("phone camera did not open"); return null }
            val d = device!!
            val configured = CountDownLatch(1)
            var session: CameraCaptureSession? = null
            @Suppress("DEPRECATION")
            d.createCaptureSession(listOf(reader.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) { session = s; configured.countDown() }
                override fun onConfigureFailed(s: CameraCaptureSession) { configured.countDown() }
            }, handler)
            if (!configured.await(4, TimeUnit.SECONDS) || session == null) { log("phone camera session failed"); return null }
            val req = d.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
                set(CaptureRequest.LENS_FOCUS_DISTANCE, hyper)
                set(CaptureRequest.JPEG_QUALITY, 92.toByte())
                set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF)
                set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
                set(CaptureRequest.DISTORTION_CORRECTION_MODE, CaptureRequest.DISTORTION_CORRECTION_MODE_OFF)
            }.build()
            session!!.capture(req, object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, result: TotalCaptureResult) {
                    sensorTs = result.get(android.hardware.camera2.CaptureResult.SENSOR_TIMESTAMP) ?: 0L
                }
            }, handler)
            if (!done.await(6, TimeUnit.SECONDS)) { log("phone camera still timed out"); return null }
            session?.close()
        } catch (e: Exception) {
            log("phone camera: $e"); return null
        } finally {
            device?.close(); reader.close(); thread.quitSafely()
        }
        val tsSource = ch.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
        fun fa(a: FloatArray?) = a?.joinToString(",", "[", "]") ?: "null"
        val active = ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val pix = ch.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val phys = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        meta.writeText("""{"camera_id":"$id","width":${size.width},"height":${size.height},""" +
            """"intrinsics":${fa(ch.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION))},""" +
            """"distortion":${fa(ch.get(CameraCharacteristics.LENS_DISTORTION))},""" +
            """"pose_translation":${fa(ch.get(CameraCharacteristics.LENS_POSE_TRANSLATION))},""" +
            """"pose_rotation":${fa(ch.get(CameraCharacteristics.LENS_POSE_ROTATION))},""" +
            """"focal_lengths":${fa(ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS))},""" +
            """"active_array":[${active?.left},${active?.top},${active?.right},${active?.bottom}],""" +
            """"pixel_array":[${pix?.width},${pix?.height}],"physical_size_mm":[${phys?.width},${phys?.height}],""" +
            """"focus_distance_diopters":$hyper,"sensor_timestamp_ns":$sensorTs,"timestamp_source_realtime":${tsSource == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME},""" +
            """"elapsed_realtime_ns_after":${SystemClock.elapsedRealtimeNanos()}}""" + "\n")
        log("phone still ${size.width}x${size.height} (camera $id) saved")
        return sensorTs
    }
}
