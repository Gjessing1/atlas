package io.gjessing.atlas.commutewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.res.Resources
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.text.SpannableString
import android.text.style.StrikethroughSpan
import android.view.View
import android.widget.RemoteViews
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Paints the widget from the board the backend rendered, and decides when to ask
 * for the next one.
 *
 * Everything here is per instance. Two widgets can show two directions (⚙), each
 * keeps its own last-good board, and each schedules its own next refresh — where
 * the first version had one global snapshot and one 15-minute
 * `PeriodicWorkRequest` for all of them.
 *
 * Three rules this file exists to keep:
 *
 *  - **It paints; it does not format.** Every departure string comes from
 *    `@atlas/transit` through `POST /api/transit/widget`, part by part. Kotlin
 *    chooses columns and colours, which are paint decisions, and owns words only
 *    about the widget's *own* state ("Refreshing…", "out of date").
 *  - **Colour comes from the row's `state`, never from its position.** Fading
 *    rows two and three — which the first layout did — says "less important"
 *    about a cancellation that happens to be second.
 *  - **Nothing on screen may quietly go stale.** The countdown is a Chronometer
 *    ticking locally against the departure instant, so it cannot freeze at a
 *    server-rendered "in 6 min"; and the board's own age is checked on every
 *    paint, so an answer nobody could refresh says so instead of looking current.
 */
class CommuteWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    renderAll(context)
    appWidgetIds.forEach { refresh(context, it) }
  }

  override fun onEnabled(context: Context) {
    // A provider with a configuration activity is not guaranteed an immediate
    // onUpdate callback when its first instance is bound. Paint the setup state
    // synchronously so the launcher never holds only the static XML preview
    // while WorkManager waits for its execution slot.
    renderAll(context)
    refresh(context, null)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    appWidgetIds.forEach { id ->
      CommuteWidgetStore.forget(context, id)
      WorkManager.getInstance(context).cancelUniqueWork(work(id))
    }
  }

  /**
   * Resized. Repaint from the board already held — the row count follows the new
   * bounds — and ask upstream again only when the widget grew, since that is the
   * only case where the answer on hand is short of what now fits.
   */
  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    val wanted = rowsWanted(context, appWidgetId)
    appWidgetManager.updateAppWidget(appWidgetId, render(context, appWidgetId))
    if (wanted > CommuteWidgetStore.rowsAsked(context, appWidgetId)) refresh(context, appWidgetId)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) {
      val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
      // Answer the tap now, before WorkManager has an execution slot: a ↻ that
      // does nothing visible for a second reads as a dead button, and the whole
      // point of the button is the moment you doubt what you are looking at.
      val ids = if (id >= 0) intArrayOf(id) else widgetIds(context)
      ids.forEach { CommuteWidgetStore.setState(context, it, CommuteWidgetStore.STATE_REFRESHING) }
      renderAll(context)
      refresh(context, if (id >= 0) id else null)
    }
  }

  companion object {
    const val ACTION_REFRESH = "io.gjessing.atlas.commutewidget.REFRESH"

    /** Two directions at most: "both" is the widest the board itself goes. */
    private const val MAX_BLOCKS = 2

    /** The most rows one direction can hold — `POST /api/transit/widget` caps at 6. */
    private const val MAX_ROWS = 6

    /**
     * The layout's own vertical budget, in dp: the header with its 48dp touch
     * targets, the card's padding, one direction heading, one departure row.
     * Measured against the XML rather than guessed — they are what decides how
     * many rows an instance of a given height can show.
     */
    private const val HEADER_DP = 48
    private const val PADDING_DP = 18
    private const val LABEL_DP = 15

    /** A row on one line — time, delay, countdown, vehicles. */
    private const val ROW_DP = 21

    /** A row with its second line: the vehicles and the change between them. */
    private const val ROW_TALL_DP = 33

    /**
     * Below this many rows, the taller kind is not worth its height.
     *
     * The trade is real and it is settled by the count: three complete journeys
     * beat five half-answers, but *one* complete journey is a worse widget than
     * two ordinary ones — a board showing a single departure cannot be glanced
     * at for "and if I miss it?", which is half of why anyone puts a commute on
     * their home screen. So a short instance, and each half of a two-direction
     * one, falls back to the single-line row it had before.
     */
    private const val MIN_DETAILED_ROWS = 2

    /** What a 4×3 placement is worth when the launcher has not said yet. */
    private const val DEFAULT_WIDTH_DP = 250
    private const val DEFAULT_HEIGHT_DP = 180

    /** Below this the platform column is dropped: the lines matter more than the quay. */
    private const val NARROW_DP = 210

    /** And above this there is room for the journey's total beside the countdown. */
    private const val WIDE_DP = 250

    /**
     * Past this the countdown stops ticking and states itself in words. A
     * Chronometer reads "2:47:31" three hours out, which is both wide and less
     * useful than "in 2 h 47 min".
     */
    private const val TICKING_MAX_MIN = 90

    /** An answer older than this is called out rather than quietly shown. */
    private const val STALE_MS = 10 * 60_000L

    /** A ↻ that never reached the network should not say "Refreshing…" for ever. */
    private const val REFRESHING_MS = 90_000L

    /**
     * The link a tap follows: the commute board itself, not a bare launch into
     * whatever screen the app was last on. `panel=commute` is the shape both
     * clients read (`decodePanelLink` in `@atlas/core`).
     *
     * Deliberately the `atlas:` scheme rather than an https App Link built from
     * the configured origin. The App Link is only verified for the default server
     * host, so a device pointed at a LAN dev backend — or any self-hosted origin
     * that is not `atlas.gjessing.io` — would produce an ACTION_VIEW intent this
     * package cannot resolve, and the tap would do nothing at all. The scheme is
     * registered unconditionally.
     */
    private val BOARD_URI: Uri = Uri.parse("atlas://panel=commute")

    private fun work(widgetId: Int) = "atlas-commute-widget-$widgetId"

    private fun constraints() =
      Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun widgetIds(context: Context): IntArray =
      AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context, CommuteWidgetProvider::class.java))

    /** Ask now — a fresh widget, a ⚙ change, or the ↻ button. */
    fun refresh(context: Context, widgetId: Int?) {
      val ids = if (widgetId == null) widgetIds(context) else intArrayOf(widgetId)
      for (id in ids) {
        val request = OneTimeWorkRequestBuilder<CommuteWidgetWorker>()
          .setConstraints(constraints())
          .setInputData(Data.Builder().putInt(CommuteWidgetWorker.WIDGET_ID, id).build())
          .build()
        WorkManager.getInstance(context)
          .enqueueUniqueWork(work(id), ExistingWorkPolicy.REPLACE, request)
      }
    }

    /**
     * Ask again at the instant the board itself named. Clamped here as well as in
     * `@atlas/transit` because a stored board can be older than this process: a
     * `nextRefreshMs` already in the past must become "soon", never "now, in a
     * loop".
     */
    fun scheduleNext(context: Context, widgetId: Int, nextRefreshMs: Long) {
      val delayMs =
        (nextRefreshMs - System.currentTimeMillis()).coerceIn(5 * 60_000L, 6 * 60 * 60_000L)
      val request = OneTimeWorkRequestBuilder<CommuteWidgetWorker>()
        .setConstraints(constraints())
        .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
        .setInputData(Data.Builder().putInt(CommuteWidgetWorker.WIDGET_ID, widgetId).build())
        .build()
      WorkManager.getInstance(context)
        .enqueueUniqueWork(work(widgetId), ExistingWorkPolicy.REPLACE, request)
    }

    fun renderAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for (id in widgetIds(context)) manager.updateAppWidget(id, render(context, id))
    }

    /** The widget picker's populated sample, also offered as the pin-request preview. */
    fun previewViews(context: Context): RemoteViews =
      RemoteViews(context.packageName, R.layout.atlas_commute_widget_preview)

    /**
     * How many departures per direction this instance can show — which is also
     * how many the worker asks upstream for, since fetching six to paint two is
     * somebody's Entur quota.
     */
    fun rowsWanted(context: Context, widgetId: Int): Int {
      val blocks = if (CommuteWidgetStore.direction(context, widgetId) == "both") 2 else 1
      return rowPlan(sizeOf(context, widgetId).second, blocks).second
    }

    /**
     * How this instance spends its height: whether a row can afford its second
     * line, and how many rows fit either way.
     */
    private fun rowPlan(heightDp: Int, blocks: Int): Pair<Boolean, Int> {
      val tall = rowCapacity(heightDp, blocks, ROW_TALL_DP)
      return if (tall >= MIN_DETAILED_ROWS) Pair(true, tall)
      else Pair(false, rowCapacity(heightDp, blocks, ROW_DP))
    }

    /** Rows that fit in `heightDp` once the header, padding and headings are paid for. */
    private fun rowCapacity(heightDp: Int, blocks: Int, rowDp: Int): Int {
      val body = heightDp - HEADER_DP - PADDING_DP
      val perBlock = body / blocks.coerceAtLeast(1) - if (blocks > 1) LABEL_DP else 0
      return (perBlock / rowDp).coerceIn(1, MAX_ROWS)
    }

    /** This instance's bounds in dp, in the orientation the home screen is in. */
    private fun sizeOf(context: Context, widgetId: Int): Pair<Int, Int> {
      val options: Bundle =
        runCatching { AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId) }
          .getOrNull() ?: Bundle()
      val portrait =
        Resources.getSystem().configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
      // The four OPTION_* extras bracket both orientations at once: width is
      // narrowest in portrait and height is tallest there.
      val width =
        options.getInt(
          if (portrait) AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH
          else AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,
        )
      val height =
        options.getInt(
          if (portrait) AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
          else AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,
        )
      return Pair(
        if (width > 0) width else DEFAULT_WIDTH_DP,
        if (height > 0) height else DEFAULT_HEIGHT_DP,
      )
    }

    /**
     * A context whose resources answer in the *launcher's* night mode.
     *
     * Atlas pins itself to light (`userInterfaceStyle` in app.json), so
     * `context.getColor` would hand back the light palette for a widget sitting
     * on a dark home screen. Colours named from the layout XML are already
     * resolved by the host and are fine; these are the ones chosen per row.
     */
    private fun themed(context: Context): Context {
      val night =
        Resources.getSystem().configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
      val config = Configuration(context.resources.configuration)
      config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
      return context.createConfigurationContext(config)
    }

    /**
     * `optString` answers `"null"` — the four-character string — for a field
     * whose value is JSON null, which is how a widget ends up printing `null`
     * in the column where a delay would go. Every optional string is read here.
     */
    private fun JSONObject.string(name: String): String =
      if (isNull(name)) "" else optString(name)

    /** The one colour decision in the widget: what a row *is*. */
    private fun stateColor(res: Context, state: String): Int =
      res.getColor(
        when (state) {
          "cancelled" -> R.color.atlas_widget_error
          "delayed", "early" -> R.color.atlas_widget_warn
          "live" -> R.color.atlas_widget_accent
          else -> R.color.atlas_widget_muted
        },
      )

    private fun render(context: Context, widgetId: Int): RemoteViews {
      val res = themed(context)
      val views = RemoteViews(context.packageName, R.layout.atlas_commute_widget)
      val board = CommuteWidgetStore.board(context, widgetId)?.let {
        runCatching { JSONObject(it) }.getOrNull()
      }
      val nowMs = System.currentTimeMillis()
      val (widthDp, heightDp) = sizeOf(context, widgetId)
      val directions = board?.optJSONArray("directions") ?: JSONArray()
      val blocks = directions.length().coerceAtMost(MAX_BLOCKS)

      // With one direction the heading *is* the title: "Engelsrud →
      // Nationaltheatret" says strictly more than "Engelsrud ↔ Nationaltheatret"
      // above it, and the line it saves is another departure.
      val single = if (blocks == 1) directions.optJSONObject(0)?.string("label") else null
      val title = single?.takeUnless { it.isBlank() }
        ?: board?.string("route")?.takeUnless { it.isBlank() }
        ?: res.getString(R.string.atlas_commute_widget_setup_route)
      views.setTextViewText(R.id.atlas_commute_route, title)

      val status = statusLine(res, context, widgetId, board, nowMs, widthDp)
      views.setTextViewText(R.id.atlas_commute_status, status.first)
      views.setTextColor(R.id.atlas_commute_status, status.second)
      // Deliberately no description on the root: it is the clickable node, and a
      // clickable group that has one is read *instead of* everything inside it —
      // which would announce the widget as its own title and hide every
      // departure. The route, the status and each row speak for themselves.

      views.removeAllViews(R.id.atlas_commute_body)
      val (detailed, perDirection) = rowPlan(heightDp, blocks.coerceAtLeast(1))
      for (block in 0 until blocks) {
        val direction = directions.optJSONObject(block) ?: continue
        if (blocks > 1) {
          val label = RemoteViews(context.packageName, R.layout.atlas_commute_label)
          label.setTextViewText(R.id.atlas_commute_label, direction.string("label").uppercase())
          views.addView(R.id.atlas_commute_body, label)
        }
        val rows = direction.optJSONArray("rows") ?: JSONArray()
        val shown = rows.length().coerceAtMost(perDirection)
        for (index in 0 until shown) {
          val row = rows.optJSONObject(index) ?: continue
          views.addView(
            R.id.atlas_commute_body,
            rowViews(context, res, row, nowMs, widthDp, detailed),
          )
        }
        // A direction with nothing to show says why, instead of collapsing to an
        // empty block that reads as a broken widget; a direction that does show
        // departures gets its disruption headline only if a row slot is spare.
        val note = if (shown == 0) direction.string("note") else noteAmong(rows, shown)
        if (!note.isNullOrBlank() && (shown == 0 || shown < perDirection)) {
          val view = RemoteViews(context.packageName, R.layout.atlas_commute_note)
          view.setTextViewText(R.id.atlas_note_text, note)
          views.addView(R.id.atlas_commute_body, view)
        }
      }

      views.setOnClickPendingIntent(
        R.id.atlas_commute_refresh,
        PendingIntent.getBroadcast(
          context,
          widgetId,
          Intent(context, CommuteWidgetProvider::class.java).apply {
            action = ACTION_REFRESH
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
          },
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      views.setOnClickPendingIntent(
        R.id.atlas_commute_configure,
        PendingIntent.getActivity(
          context,
          widgetId,
          Intent(context, CommuteWidgetConfigureActivity::class.java).apply {
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
          },
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      views.setOnClickPendingIntent(
        R.id.atlas_commute_widget_root,
        PendingIntent.getActivity(
          context,
          widgetId,
          Intent(Intent.ACTION_VIEW, BOARD_URI).setPackage(context.packageName),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      return views
    }

    /** The first disruption headline among the rows actually on screen. */
    private fun noteAmong(rows: JSONArray, shown: Int): String? {
      for (index in 0 until shown) {
        val note = rows.optJSONObject(index)?.string("note")
        if (!note.isNullOrBlank()) return note
      }
      return null
    }

    /**
     * The line under the route, and the colour it is painted in.
     *
     * Order matters: what the widget is *doing* (refreshing, or failed to)
     * outranks how old its answer is, and both outrank the board's own
     * "Entur live · checked 07:04" — which is only true for as long as it is.
     */
    private fun statusLine(
      res: Context,
      context: Context,
      widgetId: Int,
      board: JSONObject?,
      nowMs: Long,
      widthDp: Int,
    ): Pair<CharSequence, Int> {
      val state = CommuteWidgetStore.state(context, widgetId)
      val stateAgeMs = nowMs - CommuteWidgetStore.stateAtMs(context, widgetId)
      if (state == CommuteWidgetStore.STATE_REFRESHING && stateAgeMs < REFRESHING_MS) {
        return Pair(
          res.getString(R.string.atlas_commute_widget_refreshing),
          res.getColor(R.color.atlas_widget_accent),
        )
      }
      if (state == CommuteWidgetStore.STATE_FAILED) {
        return Pair(
          res.getString(R.string.atlas_commute_widget_failed),
          res.getColor(R.color.atlas_widget_warn),
        )
      }
      val checkedMs = board?.optLong("checkedMs") ?: 0L
      if (board == null || state == CommuteWidgetStore.STATE_SETUP) {
        return Pair(
          res.getString(R.string.atlas_commute_widget_setup_status),
          res.getColor(R.color.atlas_widget_muted),
        )
      }
      if (checkedMs > 0L && nowMs - checkedMs > STALE_MS) {
        // Aged locally, because the server cannot know how long its answer has
        // been sitting there. A widget nobody could refresh — no network, a
        // sleeping device — used to keep the same confident line all morning.
        return Pair(
          res.getString(R.string.atlas_commute_widget_stale, board.string("checked")),
          res.getColor(R.color.atlas_widget_warn),
        )
      }
      // Narrow instances drop the clock and keep the source: "Entur live".
      val line = if (widthDp < NARROW_DP) board.string("source") else board.string("status")
      return Pair(
        line.takeUnless { it.isBlank() } ?: board.string("status"),
        res.getColor(R.color.atlas_widget_muted),
      )
    }

    /** One journey, in columns, coloured by what it is. */
    private fun rowViews(
      context: Context,
      res: Context,
      row: JSONObject,
      nowMs: Long,
      widthDp: Int,
      detailed: Boolean,
    ): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.atlas_commute_row)
      val cancelled = row.optBoolean("cancelled")
      val color = stateColor(res, row.string("state"))
      val time = row.string("time")

      if (time.isBlank()) {
        // A board kept by the version before this one has no columns, only the
        // single line it used to paint. It is replaced within seconds of the
        // upgrade — the package-replaced broadcast refreshes every instance —
        // and until then this is exactly the contract `text` exists for.
        for (id in intArrayOf(
          R.id.atlas_row_time,
          R.id.atlas_row_arrow,
          R.id.atlas_row_arrival,
          R.id.atlas_row_delay,
          R.id.atlas_row_duration,
          R.id.atlas_row_platform,
          R.id.atlas_row_countdown,
          R.id.atlas_row_countdown_text,
          R.id.atlas_row_detail,
        )) {
          views.setViewVisibility(id, View.GONE)
        }
        setText(views, R.id.atlas_row_lines_inline, row.string("text"))
        views.setContentDescription(R.id.atlas_row_root, row.string("text"))
        return views
      }

      views.setTextViewText(
        R.id.atlas_row_time,
        // A cancelled departure's time is struck through rather than merely
        // recoloured: colour alone is the one distinction some readers do not get.
        if (cancelled) SpannableString(time).apply {
          setSpan(StrikethroughSpan(), 0, length, 0)
        } else time,
      )
      views.setTextColor(
        R.id.atlas_row_time,
        if (cancelled) color else res.getColor(R.color.atlas_widget_text),
      )

      // Where this departure gets you, which is the other half of the question
      // and the half the widget used not to answer. A stop board has no
      // arrival — it knows when the 280 leaves, not where its reader is going —
      // and a compact row on a narrow instance needs the width for the vehicles.
      val arrival = if (!detailed && widthDp < NARROW_DP) "" else row.string("arrival")
      setText(views, R.id.atlas_row_arrival, arrival)
      views.setViewVisibility(
        R.id.atlas_row_arrow,
        if (arrival.isNullOrBlank()) View.GONE else View.VISIBLE,
      )

      val delay = row.string("delayLabel")
      setText(views, R.id.atlas_row_delay, delay)
      if (!delay.isNullOrBlank()) views.setTextColor(R.id.atlas_row_delay, color)

      val whenMs = row.optLong("whenMs")
      val ticking =
        !cancelled && whenMs > nowMs && row.optInt("countdownMin") <= TICKING_MAX_MIN
      if (ticking) {
        // Chronometer counts in elapsed-realtime, so the base is the departure
        // expressed in that clock. It then ticks on its own: no wakeup of ours,
        // and nothing to go stale between refreshes.
        views.setChronometer(
          R.id.atlas_row_countdown,
          SystemClock.elapsedRealtime() + (whenMs - nowMs),
          null,
          true,
        )
        views.setChronometerCountDown(R.id.atlas_row_countdown, true)
        views.setTextColor(
          R.id.atlas_row_countdown,
          // A live prediction Entur itself flags as inaccurate should not look
          // like one you can plan around.
          if (row.optBoolean("predictionInaccurate")) res.getColor(R.color.atlas_widget_muted)
          else color,
        )
        views.setViewVisibility(R.id.atlas_row_countdown, View.VISIBLE)
        views.setViewVisibility(R.id.atlas_row_countdown_text, View.GONE)
      } else {
        views.setViewVisibility(R.id.atlas_row_countdown, View.GONE)
        setText(views, R.id.atlas_row_countdown_text, row.string("countdown"))
        views.setTextColor(R.id.atlas_row_countdown_text, color)
      }

      // The vehicles, on their own line when there is room for one. When there
      // is not, `atlas_row_lines_inline` stops being a spacer and carries them
      // on line one instead — the same string, one place further up.
      val lines = row.string("lines")
      val linesColor =
        if (cancelled) res.getColor(R.color.atlas_widget_muted)
        else res.getColor(R.color.atlas_widget_text)
      if (detailed) {
        views.setViewVisibility(R.id.atlas_row_detail, View.VISIBLE)
        // INVISIBLE, not GONE: the weighted column is what holds the countdown
        // against the right edge, and a GONE spacer would let it drift left.
        views.setTextViewText(R.id.atlas_row_lines_inline, "")
        views.setViewVisibility(R.id.atlas_row_lines_inline, View.INVISIBLE)
        setText(views, R.id.atlas_row_lines, lines)
        views.setTextColor(R.id.atlas_row_lines, linesColor)
        setText(
          views,
          R.id.atlas_row_changes,
          if (widthDp < NARROW_DP) "" else row.string("changes"),
        )
        setText(
          views,
          R.id.atlas_row_duration,
          if (widthDp < WIDE_DP) "" else row.string("duration"),
        )
      } else {
        views.setViewVisibility(R.id.atlas_row_detail, View.GONE)
        views.setViewVisibility(R.id.atlas_row_duration, View.GONE)
        setText(views, R.id.atlas_row_lines_inline, lines)
        views.setTextColor(R.id.atlas_row_lines_inline, linesColor)
      }
      setText(
        views,
        R.id.atlas_row_platform,
        if (widthDp < NARROW_DP) "" else row.string("platform"),
      )
      // Read out as one row — "07:10 (+6) → 08:14 · 48 min · in 6 min · 280 →
      // RE10 · 9 min at Asker stasjon · plt 2" — rather than as eight unrelated
      // fragments.
      views.setContentDescription(R.id.atlas_row_root, row.string("text"))
      return views
    }

    private fun setText(views: RemoteViews, id: Int, value: String?) {
      val text = value.orEmpty()
      views.setTextViewText(id, text)
      views.setViewVisibility(id, if (text.isEmpty()) View.GONE else View.VISIBLE)
    }
  }
}
