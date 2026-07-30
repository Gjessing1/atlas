package io.gjessing.atlas.commutewidget

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

class CommuteWidgetWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {
  override fun doWork(): Result {
    val query = CommuteWidgetStore.query(applicationContext)
    val baseUrl = CommuteWidgetStore.baseUrl(applicationContext)
    if (query == null || baseUrl == null) {
      CommuteWidgetStore.save(
        applicationContext,
        emptyList(),
        emptyList(),
        "Open Atlas to set up your commute",
      )
      CommuteWidgetProvider.renderAll(applicationContext)
      return Result.success()
    }

    return try {
      val connection = URL("$baseUrl/api/transit/commute").openConnection() as HttpURLConnection
      connection.requestMethod = "POST"
      connection.connectTimeout = 10_000
      // An evening refresh is the case where the board has to widen its search
      // window, asking Entur up to three times per direction; measured end to
      // end at 2.4–3.2 s, but the backend allows each of those upstream calls
      // 10 s. Read well past that so a real upstream failure arrives as an
      // error to show, rather than as this worker giving up on an answer that
      // was on its way — which would blank exactly the "what is my morning bus"
      // check the widget exists for.
      connection.readTimeout = 25_000
      connection.doOutput = true
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Content-Type", "application/json")
      connection.outputStream.use { it.write(query.toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode !in 200..299) throw IllegalStateException("HTTP ${connection.responseCode}")
      val response = connection.inputStream.bufferedReader().use { it.readText() }
      val root = JSONObject(response)
      val outbound = tripRows(root.getJSONObject("outbound").optJSONArray("trips"))
      val inbound = tripRows(root.getJSONObject("inbound").optJSONArray("trips"))
      val checked = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
      CommuteWidgetStore.save(
        applicationContext,
        outbound,
        inbound,
        if (outbound.isEmpty() && inbound.isEmpty()) {
          "No matching journeys · checked $checked"
        } else {
          "Entur live · checked $checked"
        },
      )
      CommuteWidgetProvider.renderAll(applicationContext)
      Result.success()
    } catch (_: Exception) {
      val cached = CommuteWidgetStore.snapshot(applicationContext)
      CommuteWidgetStore.save(
        applicationContext,
        cached.outbound,
        cached.inbound,
        "Couldn’t refresh · tap ↻",
      )
      CommuteWidgetProvider.renderAll(applicationContext)
      Result.retry()
    }
  }

  private fun tripRows(trips: JSONArray?): List<String> {
    if (trips == null) return emptyList()
    return (0 until minOf(trips.length(), 2)).map { index ->
      val trip = trips.getJSONObject(index)
      val start = clock(trip.optLong("startMs"))
      val end = clock(trip.optLong("endMs"))
      val legs = trip.optJSONArray("legs")
      val lines = mutableListOf<String>()
      if (legs != null) {
        for (legIndex in 0 until legs.length()) {
          val line = legs.optJSONObject(legIndex)?.optJSONObject("line")?.optString("publicCode")
          if (!line.isNullOrBlank()) lines.add(line)
        }
      }
      "$start–$end  ${lines.joinToString(" → ")}".trim()
    }
  }

  private fun clock(epochMs: Long): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(epochMs))

  companion object {
    fun routeNames(query: String?): String? {
      if (query == null) return null
      return try {
        val root = JSONObject(query)
        val from = root.getJSONObject("from").getString("name")
        val to = root.getJSONObject("to").getString("name")
        val via = root.optJSONArray("via")?.optJSONObject(0)?.optString("name")
        if (via.isNullOrBlank()) "$from ↔ $to" else "$from ↔ $to · via $via"
      } catch (_: Exception) {
        null
      }
    }
  }
}
