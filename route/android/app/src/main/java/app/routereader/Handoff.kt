package app.routereader

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * What was read goes to the planner's Worker (POST /api/handoff), which keeps
 * it a short while under a random id; the planner opens with #handoff=<id>
 * and reads it there (route/src/handoff.js, route/public/app.js).
 */
object Handoff {
    fun send(base: String, result: ReadResult): String {
        val conn = URL("$base/api/handoff").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 15000
            conn.readTimeout = 60000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(result.toJson().toString().toByteArray()) }
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText().orEmpty()
            if (code !in 200..299) throw Exception(runCatching { JSONObject(body).getString("error") }.getOrDefault("the planner said $code"))
            return JSONObject(body).getString("id")
        } finally {
            conn.disconnect()
        }
    }
}
