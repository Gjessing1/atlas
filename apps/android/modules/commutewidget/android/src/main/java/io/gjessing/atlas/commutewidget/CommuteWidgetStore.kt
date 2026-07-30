package io.gjessing.atlas.commutewidget

import android.content.Context

/**
 * What the widget knows, split into what the *app* owns and what each *instance*
 * owns.
 *
 * App-owned (one copy): the server origin and the saved commute, written by
 * `configureCommuteWidget` whenever the shared `transit.commute` setting
 * changes. Instance-owned (one copy per `appWidgetId`): which direction this
 * widget shows — so two widgets can show two directions — and the last board the
 * backend rendered for it, held verbatim, because a widget that blanks when a
 * refresh fails is worse than one showing an answer it admits is old.
 */
internal object CommuteWidgetStore {
  private const val PREFS = "atlas_commute_widget"
  private const val BASE_URL = "base_url"
  private const val QUERY = "query"

  /** The default: outbound before the outbound time, the way home after it. */
  const val DIRECTION_AUTO = "auto"

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
    prefs(context).edit().putString("board_$widgetId", board).remove("status_$widgetId").apply()
  }

  /**
   * A status that overrides the board's own — set when a refresh failed, so the
   * kept rows stay on screen under an honest "couldn't refresh" line.
   */
  fun status(context: Context, widgetId: Int): String? =
    prefs(context).getString("status_$widgetId", null)

  fun saveStatus(context: Context, widgetId: Int, status: String) {
    prefs(context).edit().putString("status_$widgetId", status).apply()
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
      .remove("status_$widgetId")
      .apply()
  }
}
