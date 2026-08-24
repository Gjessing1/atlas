package io.gjessing.atlas.commutewidget

import android.content.Context

/**
 * What the widget knows, split into what the *app* owns and what each *instance*
 * owns.
 *
 * App-owned (one copy): the server origin and the saved commute, written by
 * `configureCommuteWidget` whenever the shared `transit.commute` setting
 * changes. Instance-owned (one copy per `appWidgetId`): which direction this
 * widget shows — so two widgets can show two directions — the last board the
 * backend rendered for it, held verbatim, because a widget that blanks when a
 * refresh fails is worse than one showing an answer it admits is old, and what
 * the instance is currently *doing*, which is the one thing the board cannot say.
 */
internal object CommuteWidgetStore {
  private const val PREFS = "atlas_commute_widget"
  private const val BASE_URL = "base_url"
  private const val QUERY = "query"

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

  fun configure(context: Context, baseUrl: String, query: String?) {
    prefs(context).edit()
      .putString(BASE_URL, baseUrl.trimEnd('/'))
      .apply { if (query == null) remove(QUERY) else putString(QUERY, query) }
      .apply()
  }

  fun baseUrl(context: Context): String? = prefs(context).getString(BASE_URL, null)

  fun query(context: Context): String? = prefs(context).getString(QUERY, null)

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
      .remove("board_$widgetId")
      .remove("state_$widgetId")
      .remove("state_at_$widgetId")
      .remove("rows_$widgetId")
      .apply()
  }
}
