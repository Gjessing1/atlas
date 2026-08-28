package io.gjessing.atlas.commutewidget.v2

import android.content.Context

/**
 * What the **v2** widget knows — ROADMAP §6.5.
 *
 * ---
 * **Which widget is this?** Two commute widgets ship side by side and they are
 * different products, not two versions of one:
 *
 *  - **v1 — "Atlas commute"**, `io.gjessing.atlas.commutewidget`. One instance
 *    answers one board, chosen in its ⚙ and fixed until changed.
 *  - **v2 — "Atlas commute (live)"**, this package. One instance holds the whole
 *    commute: both directions behind a compact selector, and content that
 *    follows where you are in the journey.
 *
 * v1 stays the fallback and the reference until v2 has been commuted with (§7),
 * so nothing here writes into v1's `SharedPreferences` and nothing there reads
 * these keys. That separation is the whole reason this is its own store: a
 * shared file would make "uninstall v2" or "reset v2" impossible to do without
 * touching the widget that still works.
 * ---
 *
 * App-owned (one copy): the server origin, the saved commute, and the coarse
 * place the app last observed — all written by `configureCommuteWidgetV2` /
 * `reportCommutePlace`. Instance-owned (one copy per `appWidgetId`): the
 * selector and when it was set, the committed journey, the last board the
 * backend rendered, and what the instance is currently doing.
 */
internal object CommuteWidgetV2Store {
  private const val PREFS = "atlas_commute_widget_v2"
  private const val BASE_URL = "base_url"
  private const val QUERY = "query"
  private const val PLACE = "place"
  private const val PLACE_AT = "place_at"

  /** The default: whichever direction the tiers below a tap work out. */
  const val SELECTOR_AUTO = "auto"

  const val STATE_REFRESHING = "refreshing"
  const val STATE_FAILED = "failed"
  const val STATE_SETUP = "setup"

  /**
   * Beyond this, the cached fix is not consulted at all and AUTO drops to the
   * clock. A coarse position from an hour ago says where you *were*, and §6.5 §2
   * only ever allows it to choose a presentation — so letting it go quiet is
   * cheaper than letting it be wrong.
   */
  private const val PLACE_TTL_MS = 45 * 60_000L

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configure(context: Context, baseUrl: String, query: String?) {
    prefs(context).edit()
      .putString(BASE_URL, baseUrl.trimEnd('/'))
      .apply { if (query == null) remove(QUERY) else putString(QUERY, query) }
      .apply()
  }

  fun baseUrl(context: Context): String? = prefs(context).getString(BASE_URL, null)

  fun query(context: Context): String? = prefs(context).getString(QUERY, null)

  /**
   * The coarse place the *app* last observed, written only when it was in the
   * foreground with a fix already in hand. The widget never asks for one: a
   * refresh runs in a WorkManager job with no foreground service, where Android
   * throttles background location to nothing useful anyway.
   */
  fun setPlace(context: Context, place: String) {
    prefs(context).edit()
      .putString(PLACE, place)
      .putLong(PLACE_AT, System.currentTimeMillis())
      .apply()
  }

  /** The cached place, or null once it is too old to mean anything. */
  fun place(context: Context): String? {
    val store = prefs(context)
    val at = store.getLong(PLACE_AT, 0L)
    if (at <= 0L || System.currentTimeMillis() - at > PLACE_TTL_MS) return null
    return store.getString(PLACE, null)
  }

  /** `auto`, `outbound` or `inbound` — what this instance's selector is set to. */
  fun selector(context: Context, widgetId: Int): String =
    prefs(context).getString("selector_$widgetId", SELECTOR_AUTO) ?: SELECTOR_AUTO

  /**
   * When the selector was last set by hand. The *backend* decides whether a pin
   * still holds — it knows the commute's own times, and a Kotlin copy of that
   * rule would be a second answer to when a pin expires.
   */
  fun selectorAtMs(context: Context, widgetId: Int): Long =
    prefs(context).getLong("selector_at_$widgetId", 0L)

  fun setSelector(context: Context, widgetId: Int, selector: String) {
    prefs(context).edit()
      .putString("selector_$widgetId", selector)
      .putLong("selector_at_$widgetId", System.currentTimeMillis())
      .apply()
  }

  /**
   * The journey this instance is committed to, as the JSON the backend takes:
   * `{"direction","departureMs","line","committedAtMs"}`. Null when the user has
   * not tapped — and §6.5 §3 is emphatic that none is ever invented, because an
   * assumed commitment that is wrong is the one failure mode with no visible
   * cause.
   */
  fun commit(context: Context, widgetId: Int): String? =
    prefs(context).getString("commit_$widgetId", null)

  fun setCommit(context: Context, widgetId: Int, commit: String?) {
    prefs(context).edit()
      .apply { if (commit == null) remove("commit_$widgetId") else putString("commit_$widgetId", commit) }
      .apply()
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

  fun rowsAsked(context: Context, widgetId: Int): Int =
    prefs(context).getInt("rows_$widgetId", 0)

  fun setRowsAsked(context: Context, widgetId: Int, rows: Int) {
    prefs(context).edit().putInt("rows_$widgetId", rows).apply()
  }

  /** Drop the kept rows without forgetting the selector or the commitment. */
  fun clearBoard(context: Context, widgetId: Int) {
    prefs(context).edit().remove("board_$widgetId").apply()
  }

  /** Drop an instance's keys when its widget is removed. */
  fun forget(context: Context, widgetId: Int) {
    prefs(context).edit()
      .remove("selector_$widgetId")
      .remove("selector_at_$widgetId")
      .remove("commit_$widgetId")
      .remove("board_$widgetId")
      .remove("state_$widgetId")
      .remove("state_at_$widgetId")
      .remove("rows_$widgetId")
      .apply()
  }
}
