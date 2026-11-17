package app.lawnmapper.ar.thermal

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.HandlerThread
import android.view.Display
import org.json.JSONArray
import org.json.JSONObject

/**
 * DEV ONLY -- THE PHONE'S FULL ORIENTATION DURING A SINGLE THERMAL PHOTO (ThermalCamera.snap; the thermal session,
 * 2026-11-17: "please record the FULL orientation, not just tilt and heading: the TYPE_ROTATION_VECTOR quaternion at
 * the shot plus the display rotation"). ARCore may not be running for a photo, so it is read from the phone's own
 * rotation-vector sensor (Android's fused, magnetic-north one). Its own thread; listening only while a photo is taken.
 *
 * over(t0, t1) -> { q: [w, x, y, z] (the reading nearest the middle of the burst), at_ns, accuracy_deg (the sensor's
 * own estimate of the heading's error, when it gives one), display_rotation (0, 90, 180 or 270), sensor: "rotation
 * vector", samples: [{ t_ns, q }] over the burst } -- times are the sensor's (elapsedRealtimeNanos).
 */
class Rotation(private val app: Context) : SensorEventListener {
    private val sm = app.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private var thread: HandlerThread? = null
    private class S(val t: Long, val q: FloatArray, val acc: Float)
    private val got = ArrayList<S>()

    fun start() {
        val s = sensor ?: return
        val th = HandlerThread("thermal-rotation").apply { start() }
        thread = th
        sm.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME, Handler(th.looper))
    }

    fun stop() {
        try { sm.unregisterListener(this) } catch (_: Exception) {}
        thread?.quitSafely(); thread = null
    }

    override fun onSensorChanged(e: SensorEvent) {
        val q = FloatArray(4)
        SensorManager.getQuaternionFromVector(q, e.values)   // w, x, y, z
        val acc = if (e.values.size > 4) e.values[4] else -1f   // radians, the heading's estimated error
        synchronized(got) { got.add(S(e.timestamp, q, acc)); if (got.size > 2000) got.removeAt(0) }
    }

    override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {}

    fun over(t0: Long, t1: Long): JSONObject {
        val rot = try { (app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY).rotation * 90 } catch (_: Exception) { 0 }
        val o = JSONObject().put("sensor", if (sensor != null) "rotation vector" else "none").put("display_rotation", rot)
        val all = synchronized(got) { ArrayList(got) }
        if (all.isEmpty()) return o.put("q", JSONObject.NULL).put("samples", JSONArray())
        val mid = (t0 + t1) / 2
        val near = all.minByOrNull { Math.abs(it.t - mid) }!!
        val qa = { q: FloatArray -> JSONArray(q.map { Math.round(it * 1e6) / 1e6 }) }
        val samples = JSONArray()
        for (x in all) if (x.t in (t0 - 200_000_000)..(t1 + 200_000_000)) samples.put(JSONObject().put("t_ns", x.t).put("q", qa(x.q)))
        return o.put("q", qa(near.q)).put("at_ns", near.t)
            .put("accuracy_deg", if (near.acc >= 0) Math.round(Math.toDegrees(near.acc.toDouble()) * 10) / 10.0 else JSONObject.NULL)
            .put("samples", samples)
    }
}
