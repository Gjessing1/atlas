package io.gjessing.atlas.commutewidget.v2

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Fetches one **v2** instance's board and stores it verbatim.
 *
 * The sibling of `CommuteWidgetWorker` (v1), and deliberately a separate class
 * rather than a flag on that one: the request it sends is a different question —
 * a selector, a commitment and a cached place, where v1 sends "which board" —
 * and the two widgets must be able to fail independently. See
 * `CommuteWidgetV2Provider` for which widget is which.
 *
 * There is no formatting here. `POST /api/transit/widget` with `variant: "v2"`
 * returns a board that is ready to paint; this worker moves bytes, and makes
 * exactly two judgements: how many rows to ask for (the instance's own bounds
 * decide, and fetching six to paint two is somebody's Entur quota) and when to
 * ask again (the board says).
 */
class CommuteWidgetV2Worker(
  context: Context,
  params: WorkerParameters,
) : Worker(context, params) {
  override fun doWork(): Result {
    val widgetId = inputData.getInt(WIDGET_ID, -1)
    val ids =
      if (widgetId >= 0) intArrayOf(widgetId)
      else CommuteWidgetV2Provider.widgetIds(applicationContext)
    if (ids.isEmpty()) return Result.success()

    val baseUrl = CommuteWidgetV2Store.baseUrl(applicationContext)
    // Parsed defensively: a truncated or half-migrated value must read as "no
    // commute set up" rather than throw out of the worker and leave every
    // instance stuck on its last rows with no way to recover.
    val query = CommuteWidgetV2Store.query(applicationContext)?.let {
      runCatching { JSONObject(it) }.getOrNull()
    }
    if (query == null || baseUrl == null) {
      ids.forEach {
        CommuteWidgetV2Store.setState(applicationContext, it, CommuteWidgetV2Store.STATE_SETUP)
      }
      CommuteWidgetV2Provider.renderAll(applicationContext)
      return Result.success()
    }

    // Read once per run, not per instance: the cached fix is app-owned, and it
    // may only ever choose AUTO's presentation. Stale beyond its TTL the store
    // answers null and the board falls back to the clock, which is §6.5 §2's
    // "the widget must be fully usable with location switched off".
    val place = CommuteWidgetV2Store.place(applicationContext)

    var failed = false
    for (id in ids) {
      val rows = CommuteWidgetV2Provider.rowsWanted(applicationContext, id)
      val commit = CommuteWidgetV2Store.commit(applicationContext, id)?.let {
        runCatching { JSONObject(it) }.getOrNull()
      }
      val body = JSONObject()
        .put("kind", "commute")
        .put("variant", "v2")
        .put("commute", query)
        .put("selector", CommuteWidgetV2Store.selector(applicationContext, id))
        .put("pinnedAtMs", CommuteWidgetV2Store.selectorAtMs(applicationContext, id))
        .put("maxRows", rows)
        .apply {
          if (commit != null) put("commit", commit)
          if (place != null) put("place", place)
        }
        .toString()
      try {
        val board = post("$baseUrl/api/transit/widget", body)
        CommuteWidgetV2Store.saveBoard(applicationContext, id, board)
        CommuteWidgetV2Store.setRowsAsked(applicationContext, id, rows)
        val parsed = JSONObject(board)
        // The board is the authority on whether a commitment still stands: it
        // releases one whose journey is over, and one whose journey the operator
        // has withdrawn. Dropping it here too is what stops a dead commitment
        // being re-sent on every refresh for the rest of the day.
        if (commit != null && parsed.isNull("commitId")) {
          CommuteWidgetV2Store.setCommit(applicationContext, id, null)
        }
        // How many rows fit depends on how many blocks came back, which is only
        // knowable from a board — so the ask before the first one is a guess.
        // Correct it now rather than at the next scheduled refresh, which on a
        // sparse route is hours away; it converges in one step.
        if (CommuteWidgetV2Provider.rowsWanted(applicationContext, id) > rows) {
          CommuteWidgetV2Provider.refresh(applicationContext, id)
        } else {
          CommuteWidgetV2Provider.scheduleNext(
            applicationContext,
            id,
            parsed.optLong("nextRefreshMs", 0L),
          )
        }
      } catch (_: Exception) {
        failed = true
        // Keep the last good board; only the status line admits the failure.
        CommuteWidgetV2Store.setState(applicationContext, id, CommuteWidgetV2Store.STATE_FAILED)
      }
    }
    CommuteWidgetV2Provider.renderAll(applicationContext)
    return if (failed) Result.retry() else Result.success()
  }

  private fun post(url: String, body: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.connectTimeout = 10_000
    // The backend allows each upstream Entur call 10 s, and a v2 board with a
    // commitment makes two of them in parallel. Read well past that so a slow
    // answer arrives rather than being given up on.
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
