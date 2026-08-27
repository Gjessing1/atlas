package io.gjessing.atlas.commutewidget

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Fetches one widget instance's board and stores it verbatim.
 *
 * There is deliberately no formatting in this file. Its predecessor built
 * `"HH:mm–HH:mm  line → line"` with `SimpleDateFormat` — a second implementation
 * of `tripSummary` in Kotlin, which broke rule 1 and dropped the delay, the
 * cancellation, the platform and every disruption notice the trip model already
 * carried. `POST /api/transit/widget` now returns rows that are ready to paint,
 * so this worker only moves bytes and decides when to ask again.
 *
 * The one judgement it makes is *how many* rows to ask for: the instance's own
 * bounds decide that, and fetching six departures to paint two is somebody's
 * Entur quota.
 */
class CommuteWidgetWorker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {
  override fun doWork(): Result {
    val widgetId = inputData.getInt(WIDGET_ID, -1)
    // One instance when the request named one (the normal path: every refresh is
    // scheduled per widget), otherwise all of them — the app's own "the saved
    // commute changed" nudge has no particular instance in mind.
    val ids =
      if (widgetId >= 0) intArrayOf(widgetId)
      else CommuteWidgetProvider.widgetIds(applicationContext)
    if (ids.isEmpty()) return Result.success()

    val baseUrl = CommuteWidgetStore.baseUrl(applicationContext)
    // Parsed once, and defensively: the stored commute is written by the app, but
    // a truncated or half-migrated value must read as "no commute set up" rather
    // than throw out of the worker and leave every instance stuck on its last
    // rows with no way to recover.
    val query = CommuteWidgetStore.query(applicationContext)?.let {
      runCatching { JSONObject(it) }.getOrNull()
    }
    if (query == null || baseUrl == null) {
      ids.forEach {
        CommuteWidgetStore.setState(applicationContext, it, CommuteWidgetStore.STATE_SETUP)
      }
      CommuteWidgetProvider.renderAll(applicationContext)
      return Result.success()
    }

    var failed = false
    for (id in ids) {
      val rows = CommuteWidgetProvider.rowsWanted(applicationContext, id)
      val body = JSONObject()
        .put("kind", "commute")
        .put("commute", query)
        .put("direction", CommuteWidgetStore.direction(applicationContext, id))
        .put("maxRows", rows)
        .toString()
      try {
        val board = post("$baseUrl/api/transit/widget", body)
        CommuteWidgetStore.saveBoard(applicationContext, id, board)
        CommuteWidgetStore.setRowsAsked(applicationContext, id, rows)
        // How many rows fit depends on how many legs the journeys have, which is
        // only knowable from a board — so the ask before the first one is a
        // guess, and for a one-leg board (a hop, or a direct commute) it is a
        // guess two rows short. Correct it immediately rather than at the next
        // scheduled refresh, which on a sparse route is hours away. It converges
        // in one step: the second board plans from real legs, so `wanted` then
        // equals what was asked.
        if (CommuteWidgetProvider.rowsWanted(applicationContext, id) > rows) {
          CommuteWidgetProvider.refresh(applicationContext, id)
        } else {
          // Ask again when the answer stops being true, not on a wall clock: two
          // minutes before the next departure, or — with nothing upcoming —
          // before the commute's own window reopens. A fixed fifteen-minute
          // period asked all night and all weekend and could still be stale at
          // 08:05.
          val nextRefreshMs = JSONObject(board).optLong("nextRefreshMs", 0L)
          CommuteWidgetProvider.scheduleNext(applicationContext, id, nextRefreshMs)
        }
      } catch (_: Exception) {
        failed = true
        // Keep the last good rows; only the status line admits the failure.
        CommuteWidgetStore.setState(applicationContext, id, CommuteWidgetStore.STATE_FAILED)
      }
    }
    CommuteWidgetProvider.renderAll(applicationContext)
    return if (failed) Result.retry() else Result.success()
  }

  private fun post(url: String, body: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.connectTimeout = 10_000
    // The backend allows each upstream Entur call 10 s. Read well past that so a
    // slow answer arrives rather than being given up on — which would blank
    // exactly the "what is my morning bus" check the widget exists for.
    connection.readTimeout = 25_000
    connection.doOutput = true
    connection.setRequestProperty("Accept", "application/json")
    connection.setRequestProperty("Content-Type", "application/json")
    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    if (connection.responseCode !in 200..299) {
      throw IllegalStateException("HTTP ${connection.responseCode}")
    }
    return connection.inputStream.bufferedReader().use { it.readText() }
  }

  companion object {
    const val WIDGET_ID = "widgetId"
  }
}
