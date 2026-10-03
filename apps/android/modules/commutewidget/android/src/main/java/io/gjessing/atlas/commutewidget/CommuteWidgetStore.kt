package io.gjessing.atlas.commutewidget

import android.content.Context

/**
 * What the widget knows, split into what the *app* owns and what each *instance*
 * owns.
 *
 * App-owned (one copy): the server origin, the saved commute and the corridor's
 * hops, all written by `configureCommuteWidget` whenever the shared
 * `transit.commute` setting changes. Instance-owned (one copy per
 * `appWidgetId`): which board this widget shows — a direction, or one hop — so
 * two widgets can show two boards; the last board the backend rendered for it,
 * held verbatim, because a widget that blanks when a refresh fails is worse than
 * one showing an answer it admits is old; and what the instance is currently
 * *doing*, which is the one thing the board cannot say.
 *
 * The hops are stored rather than derived here for the same reason the rows are
 * not formatted here: `commuteSegments` in `@atlas/transit` decides what a
 * corridor's hops are and what each is called, and a Kotlin copy of that would
 * be a second answer to the same question.
 */
internal object CommuteWidgetStore {
  private const val PREFS = "atlas_commute_widget"
  private const val BASE_URL = "base_url"
  private const val QUERY = "query"
  private const val SEGMENTS = "segments"
  private const val STOP = "stop_"
  private const val LINES = "lines_"
  private const val LINE_LABEL = "line_label_"

  /** The default: outbound before the outbound time, the way home after it. */
  const val DIRECTION_AUTO = "auto"

  /**
   * An instance's own state, which outranks the board's status line while it
   * holds. Stored with the instant it was set: "Refreshing…" is only true for as
   * long as a refresh could plausibly still be running.
   */
  const val STATE_REFRESHING = "refreshing"
  const val STATE_FAILED = "failed"
  const val STATE_SETUP = "setup"

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configure(context: Context, baseUrl: String, query: String?, segments: String?) {
    prefs(context).edit()
      .putString(BASE_URL, baseUrl.trimEnd('/'))
      .apply { if (query == null) remove(QUERY) else putString(QUERY, query) }
      .apply { if (segments == null) remove(SEGMENTS) else putString(SEGMENTS, segments) }
      .apply()
  }

  fun baseUrl(context: Context): String? = prefs(context).getString(BASE_URL, null)

  fun setBaseUrl(context: Context, baseUrl: String) {
    prefs(context).edit().putString(BASE_URL, baseUrl.trimEnd('/')).apply()
  }

  /** Exact NSR stop and its display name belong to the widget instance. */
  fun stop(context: Context, widgetId: Int): String? =
    prefs(context).getString("$STOP$widgetId", null)

  fun lines(context: Context, widgetId: Int): String? =
    prefs(context).getString("$LINES$widgetId", null)

  fun lineLabel(context: Context, widgetId: Int): String? =
    prefs(context).getString("$LINE_LABEL$widgetId", null)

  fun setStop(context: Context, widgetId: Int, stop: String, lineId: String?, lineLabel: String?) {
    prefs(context).edit()
      .putString("$STOP$widgetId", stop)
      .apply { if (lineId == null) remove("$LINES$widgetId") else putString("$LINES$widgetId", lineId) }
      .apply { if (lineLabel == null) remove("$LINE_LABEL$widgetId") else putString("$LINE_LABEL$widgetId", lineLabel) }
      .remove("board_$widgetId")
      .apply()
  }

  fun query(context: Context): String? = prefs(context).getString(QUERY, null)

  /**
   * The corridor's hops as `[{"id","label"}, …]`, exactly as `@atlas/transit`
   * derived them. Empty for a commute with no interchange, which is the honest
   * answer rather than a gap: its only leg *is* the journey, so a hop board
   * would be the journey board with a different heading.
   */
  fun segments(context: Context): String? = prefs(context).getString(SEGMENTS, null)

  /**
   * Which board this instance shows: a direction, or a hop id (`"outbound-0"`)
   * from {@link segments}. Both go to `POST /api/transit/widget` in the same
   * field, which is the one question the field ever asked.
   */
  fun direction(context: Context, widgetId: Int): String =
    prefs(context).getString("direction_$widgetId", DIRECTION_AUTO) ?: DIRECTION_AUTO

  fun setDirection(context: Context, widgetId: Int, direction: String) {
    prefs(context).edit().putString("direction_$widgetId", direction).apply()
  }

  /** The rendered board, exactly as the backend sent it. */
  fun board(context: Context, widgetId: Int): String? =
    prefs(context).getString("board_$widgetId", null)

  fun saveBoard(context: Context, widgetId: Int, board: String) {
    prefs(context).edit()
      .putString("board_$widgetId", board)
      .remove("state_$widgetId")
      .remove("state_at_$widgetId")
      .apply()
  }

  fun state(context: Context, widgetId: Int): String? =
    prefs(context).getString("state_$widgetId", null)

  fun stateAtMs(context: Context, widgetId: Int): Long =
    prefs(context).getLong("state_at_$widgetId", 0L)

  fun setState(context: Context, widgetId: Int, state: String) {
    prefs(context).edit()
      .putString("state_$widgetId", state)
      .putLong("state_at_$widgetId", System.currentTimeMillis())
      .apply()
  }

  /**
   * How many rows per direction the last upstream call asked for. A resize only
   * needs to ask again when the widget grew past what it already holds.
   */
  fun rowsAsked(context: Context, widgetId: Int): Int =
    prefs(context).getInt("rows_$widgetId", 0)

  fun setRowsAsked(context: Context, widgetId: Int, rows: Int) {
    prefs(context).edit().putInt("rows_$widgetId", rows).apply()
  }

  /** Drop the kept rows without forgetting which direction this widget shows. */
  fun clearBoard(context: Context, widgetId: Int) {
    prefs(context).edit().remove("board_$widgetId").apply()
  }

  /** Drop an instance's keys when its widget is removed. */
  fun forget(context: Context, widgetId: Int) {
    prefs(context).edit()
      .remove("direction_$widgetId")
      .remove("$STOP$widgetId")
      .remove("$LINES$widgetId")
      .remove("$LINE_LABEL$widgetId")
      .remove("board_$widgetId")
      .remove("state_$widgetId")
      .remove("state_at_$widgetId")
      .remove("rows_$widgetId")
      .apply()
  }
}
