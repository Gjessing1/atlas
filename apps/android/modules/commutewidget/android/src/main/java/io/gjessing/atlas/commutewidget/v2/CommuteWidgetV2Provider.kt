package io.gjessing.atlas.commutewidget.v2

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
import io.gjessing.atlas.commutewidget.R
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Paints the **v2** commute widget — docs/TRANSIT.md §W1–§W7.
 *
 * ---
 * **Which widget is this?** `CommuteWidgetProvider`, one package up, is **v1**:
 * one instance answers one board, chosen in its ⚙ and fixed. This is **v2**: one
 * instance holds the whole commute — both directions behind a compact selector,
 * and content that follows where you are in the journey. They coexist on the
 * same home screen deliberately, and v1 remains the fallback and the reference
 * until v2 has been commuted with (§W7). Nothing here writes into v1's store, and
 * nothing there reads these keys.
 * ---
 *
 * Three rules inherited from v1, because they were right:
 *
 *  - **It paints; it does not format.** Every string comes from `@atlas/transit`
 *    through `POST /api/transit/widget` with `variant: "v2"`, part by part.
 *    Kotlin chooses columns and colours and owns words only about the widget's
 *    own state ("Refreshing…", "out of date").
 *  - **Colour comes from state, never from position.**
 *  - **Nothing on screen may quietly go stale.** The board's own age is checked
 *    on every paint.
 *
 * And two that are v2's own:
 *
 *  - **A tap is the interaction, not a sensor.** Tapping a row commits to that
 *    journey (§W2 tier 1); tapping the committed row again releases it. That one
 *    interaction buys the entire state ladder with no location permission, no
 *    activity recognition and no battery cost — and a wrong guess is one tap from
 *    right, which is the whole argument for spending taps instead of sensors.
 *  - **Direction and journey state are separate axes** (§W6). The selector chip
 *    says the direction; the focus chip says the phase. Conflating them is what
 *    makes a widget need a special case per combination, and this file has none.
 */
class CommuteWidgetV2Provider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    renderAll(context)
    appWidgetIds.forEach { refresh(context, it) }
  }

  override fun onEnabled(context: Context) {
    renderAll(context)
    refresh(context, null)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    appWidgetIds.forEach { id ->
      CommuteWidgetV2Store.forget(context, id)
      WorkManager.getInstance(context).cancelUniqueWork(work(id))
    }
  }

  override fun onAppWidgetOptionsChanged(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetId: Int,
    newOptions: Bundle,
  ) {
    val wanted = rowsWanted(context, appWidgetId)
    appWidgetManager.updateAppWidget(appWidgetId, render(context, appWidgetId))
    if (wanted > CommuteWidgetV2Store.rowsAsked(context, appWidgetId)) refresh(context, appWidgetId)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
    when (intent.action) {
      ACTION_REFRESH -> {
        // TRANSIT.md §W2's last bullet: refresh is the one moment context is
        // re-evaluated. Re-ask transit, consult the cached fix if it is fresh
        // enough, re-derive direction and state, repaint. "Give the widget a
        // fresh look at my situation."
        val ids = if (id >= 0) intArrayOf(id) else widgetIds(context)
        ids.forEach {
          CommuteWidgetV2Store.setState(context, it, CommuteWidgetV2Store.STATE_REFRESHING)
        }
        renderAll(context)
        refresh(context, if (id >= 0) id else null)
      }
      ACTION_SELECT -> {
        if (id < 0) return
        val selector = intent.getStringExtra(EXTRA_SELECTOR) ?: return
        val changed = selector != CommuteWidgetV2Store.selector(context, id)
        CommuteWidgetV2Store.setSelector(context, id, selector)
        // The board is *kept*, not cleared. Its rows answer the previous
        // question and `render` suppresses them for exactly that reason — but
        // its `selector.options` are the chips themselves, and dropping them
        // would leave the tap that just happened with nothing to show for it
        // until the network came back. The rows go; the control stays.
        if (changed) {
          CommuteWidgetV2Store.setState(context, id, CommuteWidgetV2Store.STATE_REFRESHING)
        }
        renderAll(context)
        if (changed) refresh(context, id)
      }
      ACTION_COMMIT -> {
        if (id < 0) return
        val rowId = intent.getStringExtra(EXTRA_COMMIT) ?: return
        // Tapping the committed journey again releases it — §W3's explicit
        // release, and the only way out that does not involve waiting.
        val current = commitId(CommuteWidgetV2Store.commit(context, id))
        CommuteWidgetV2Store.setCommit(context, id, if (current == rowId) null else commitJson(rowId))
        // Repaint immediately — the mark moves to the tapped row before the
        // network is asked, because a control that does nothing visible for a
        // second reads as a dead one. The rows themselves stay: a commitment
        // changes which journey is *followed*, not which journeys exist.
        renderAll(context)
        refresh(context, id)
      }
    }
  }

  companion object {
    const val ACTION_REFRESH = "io.gjessing.atlas.commutewidget.v2.REFRESH"
    const val ACTION_SELECT = "io.gjessing.atlas.commutewidget.v2.SELECT"
    const val ACTION_COMMIT = "io.gjessing.atlas.commutewidget.v2.COMMIT"
    const val EXTRA_SELECTOR = "selector"
    const val EXTRA_COMMIT = "commit"

    /** Two directions at most: the interchange is the only case that draws both. */
    private const val MAX_BLOCKS = 2

    /** `POST /api/transit/widget` caps `maxRows` at 6. */
    private const val MAX_ROWS = 6

    /**
     * The layout's vertical budget in dp, measured against the XML rather than
     * guessed: the selector row, the pin line, the focus block, the divider, the
     * status line and the card's own padding. What is left is rows.
     */
    private const val CHROME_DP = 30 + 11 + 62 + 7 + 12 + 18

    /** One journey row of the "and if I miss it?" list. */
    private const val ROW_DP = 20

    /** A direction heading, drawn only when two blocks share the body. */
    private const val LABEL_DP = 13

    /** What a 4×3 placement is worth when the launcher has not said yet. */
    private const val DEFAULT_WIDTH_DP = 250
    private const val DEFAULT_HEIGHT_DP = 180

    /** Below this the platform and duration columns go: the vehicles matter more. */
    private const val NARROW_DP = 210

    /**
     * Below this the third selector chip is dropped to a shorter form. Three
     * chips plus a ↻ want about 200dp, and a chip whose text is cut in half says
     * less than one that admits it is the return direction.
     */
    private const val CHIPS_DP = 230

    /** An answer older than this is called out rather than quietly shown. */
    private const val STALE_MS = 10 * 60_000L

    /** A ↻ that never reached the network should not say "Refreshing…" for ever. */
    private const val REFRESHING_MS = 90_000L

    /**
     * The link a tap on the focus follows. The `atlas:` scheme rather than an
     * https App Link, for v1's reason: the App Link is verified only for the
     * default host, so a device pointed at a self-hosted origin would produce an
     * intent this package cannot resolve and the tap would do nothing.
     */
    private val BOARD_URI: Uri = Uri.parse("atlas://panel=commute")

    private fun work(widgetId: Int) = "atlas-commute-widget-v2-$widgetId"

    private fun constraints() =
      Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun widgetIds(context: Context): IntArray =
      AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context, CommuteWidgetV2Provider::class.java))

    fun refresh(context: Context, widgetId: Int?) {
      val ids = if (widgetId == null) widgetIds(context) else intArrayOf(widgetId)
      for (id in ids) {
        val request = OneTimeWorkRequestBuilder<CommuteWidgetV2Worker>()
          .setConstraints(constraints())
          .setInputData(Data.Builder().putInt(CommuteWidgetV2Worker.WIDGET_ID, id).build())
          .build()
        WorkManager.getInstance(context)
          .enqueueUniqueWork(work(id), ExistingWorkPolicy.REPLACE, request)
      }
    }

    /**
     * Ask again at the instant the board named. The floor is two minutes rather
     * than v1's five: while a commitment is live the board's own
     * `nextRefreshMs` follows the state ladder, and a five-minute floor would
     * hold "on the bus" on screen for four minutes after arrival. It is bounded
     * by the commitment, which expires.
     */
    fun scheduleNext(context: Context, widgetId: Int, nextRefreshMs: Long) {
      val delayMs =
        (nextRefreshMs - System.currentTimeMillis()).coerceIn(2 * 60_000L, 6 * 60 * 60_000L)
      val request = OneTimeWorkRequestBuilder<CommuteWidgetV2Worker>()
        .setConstraints(constraints())
        .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
        .setInputData(Data.Builder().putInt(CommuteWidgetV2Worker.WIDGET_ID, widgetId).build())
        .build()
      WorkManager.getInstance(context)
        .enqueueUniqueWork(work(widgetId), ExistingWorkPolicy.REPLACE, request)
    }

    fun renderAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for (id in widgetIds(context)) manager.updateAppWidget(id, render(context, id))
    }

    /** The picker's populated sample, also offered as the pin-request preview. */
    fun previewViews(context: Context): RemoteViews =
      RemoteViews(context.packageName, R.layout.atlas_commute_v2_widget_preview)

    /**
     * How many departures per block this instance can show — which is also how
     * many the worker asks upstream for, since fetching six to paint two is
     * somebody's Entur quota.
     */
    fun rowsWanted(context: Context, widgetId: Int): Int {
      val blocks = blocksOf(board(context, widgetId))
      return rowCapacity(sizeOf(context, widgetId).second, blocks)
    }

    private fun board(context: Context, widgetId: Int): JSONObject? =
      CommuteWidgetV2Store.board(context, widgetId)?.let {
        runCatching { JSONObject(it) }.getOrNull()
      }

    private fun blocksOf(board: JSONObject?): Int =
      (board?.optJSONArray("blocks")?.length() ?: 1).coerceIn(1, MAX_BLOCKS)

    /** Rows that fit once the chrome is paid for. */
    private fun rowCapacity(heightDp: Int, blocks: Int): Int {
      val body = heightDp - CHROME_DP
      val perBlock = body / blocks.coerceAtLeast(1) - if (blocks > 1) LABEL_DP else 0
      return (perBlock / ROW_DP).coerceIn(1, MAX_ROWS)
    }

    /** This instance's bounds in dp, in the orientation the home screen is in. */
    private fun sizeOf(context: Context, widgetId: Int): Pair<Int, Int> {
      val options: Bundle =
        runCatching { AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId) }
          .getOrNull() ?: Bundle()
      val portrait =
        Resources.getSystem().configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
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
     * A context whose resources answer in the *launcher's* night mode. Atlas
     * pins itself to light (`userInterfaceStyle` in app.json), so `getColor`
     * would hand back the light palette for a widget on a dark home screen.
     */
    private fun themed(context: Context): Context {
      val night = Resources.getSystem().configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
      val config = Configuration(context.resources.configuration)
      config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
      return context.createConfigurationContext(config)
    }

    /**
     * `optString` answers `"null"` — the four-character string — for a field
     * whose value is JSON null, which is how v1 ended up printing `null` in the
     * column where a delay would go. Every optional string is read here.
     */
    private fun JSONObject.string(name: String): String =
      if (isNull(name)) "" else optString(name)

    /** The one colour decision: what a row or a focus *is*. */
    private fun stateColor(res: Context, state: String): Int =
      res.getColor(
        when (state) {
          "cancelled" -> R.color.atlas_widget_error
          "delayed", "early", "replacement" -> R.color.atlas_widget_warn
          "live" -> R.color.atlas_widget_accent
          else -> R.color.atlas_widget_muted
        },
      )

    /** The commit id a stored `{"direction","departureMs","line"}` stands for. */
    private fun commitId(json: String?): String? {
      val entry = json?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
      val direction = entry.optString("direction")
      val line = entry.optString("line")
      val departureMs = entry.optLong("departureMs", 0L)
      if (direction.isBlank() || line.isBlank() || departureMs <= 0L) return null
      return "$direction:$departureMs:$line"
    }

    /**
     * A row id back into the commitment the backend takes. The id *is* the three
     * fields joined — `@atlas/transit` builds it and this splits it — so there is
     * one definition of what "the same journey" means rather than two.
     */
    private fun commitJson(rowId: String): String? {
      val parts = rowId.split(':')
      if (parts.size < 3) return null
      val departureMs = parts[1].toLongOrNull() ?: return null
      return JSONObject()
        .put("direction", parts[0])
        // A line code may itself contain a colon in principle; everything after
        // the second separator is the line.
        .put("line", parts.drop(2).joinToString(":"))
        .put("departureMs", departureMs)
        .put("committedAtMs", System.currentTimeMillis())
        .toString()
    }

    private fun broadcast(context: Context, widgetId: Int, action: String, code: Int): Intent =
      Intent(context, CommuteWidgetV2Provider::class.java).apply {
        this.action = action
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        // A distinct data URI per control, because PendingIntent equality
        // ignores extras: without it every chip on one instance would collapse
        // onto whichever was created last, and the selector would have one
        // button wearing three labels.
        data = Uri.parse("atlas-widget://v2/$widgetId/$action/$code")
      }

    private fun render(context: Context, widgetId: Int): RemoteViews {
      val res = themed(context)
      val views = RemoteViews(context.packageName, R.layout.atlas_commute_v2_widget)
      val board = board(context, widgetId)
      val nowMs = System.currentTimeMillis()
      val (widthDp, heightDp) = sizeOf(context, widgetId)

      // Whether the board on hand answers the question the widget is now asking.
      // After a selector tap it does not — it lists the other direction — and a
      // widget titled "TO HOME" showing departures towards town is the one
      // failure a board like this must not have.
      val answersNow =
        board == null ||
          board.optJSONObject("selector")?.string("mode").orEmpty() ==
            CommuteWidgetV2Store.selector(context, widgetId)

      renderSelector(context, res, views, widgetId, board, widthDp)

      // What the widget is holding on the reader's behalf: a pinned direction
      // and its expiry, or the committed journey and how to let it go. Both are
      // decisions made once that keep applying, so both stay visible.
      val commitNote = board?.string("commitNote").orEmpty()
      val pinNote = board?.optJSONObject("selector")?.string("note").orEmpty()
      // Both sentences are `@atlas/transit`'s own, including "tap it again to
      // release" — which is only true while the committed row is on screen, and
      // that is something the board knows and Kotlin does not.
      setText(views, R.id.atlas_v2_pin, commitNote.ifBlank { pinNote })

      renderFocus(res, views, if (answersNow) board?.optJSONObject("focus") else null, widthDp)

      val status = statusLine(res, context, widgetId, board, nowMs, widthDp)
      views.setTextViewText(R.id.atlas_v2_status, status.first)
      views.setTextColor(R.id.atlas_v2_status, status.second)

      views.removeAllViews(R.id.atlas_v2_body)
      val blocksArray =
        (if (answersNow) board?.optJSONArray("blocks") else null) ?: JSONArray()
      val blocks = blocksArray.length().coerceAtMost(MAX_BLOCKS)
      val perBlock = rowCapacity(heightDp, blocks.coerceAtLeast(1))
      // The mark comes from the *store*, not from the board: a tap has to show
      // instantly, and the board that would confirm it is a network round trip
      // away. The board still decides whether a commitment is *released* —
      // that is the worker's job, and it is the half that must not be optimistic.
      val committed = commitId(CommuteWidgetV2Store.commit(context, widgetId)).orEmpty()
      for (index in 0 until blocks) {
        val block = blocksArray.optJSONObject(index) ?: continue
        // Only when two blocks share the body — with one, the lit selector chip
        // already names the direction and a heading would cost a departure.
        if (blocks > 1) {
          val label = RemoteViews(context.packageName, R.layout.atlas_commute_v2_label)
          label.setTextViewText(R.id.atlas_v2_label, block.string("short"))
          views.addView(R.id.atlas_v2_body, label)
        }
        val rows = block.optJSONArray("rows") ?: JSONArray()
        val shown = rows.length().coerceAtMost(perBlock)
        for (row in 0 until shown) {
          val entry = rows.optJSONObject(row) ?: continue
          views.addView(
            R.id.atlas_v2_body,
            rowViews(context, res, entry, widgetId, widthDp, committed),
          )
        }
        val note = block.string("note")
        if (shown == 0 && note.isNotBlank()) {
          val view = RemoteViews(context.packageName, R.layout.atlas_commute_v2_note)
          view.setTextViewText(R.id.atlas_v2_note, note)
          views.addView(R.id.atlas_v2_body, view)
        }
      }

      views.setOnClickPendingIntent(
        R.id.atlas_v2_refresh,
        PendingIntent.getBroadcast(
          context,
          0,
          broadcast(context, widgetId, ACTION_REFRESH, 0),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      // The focus opens the board; the rows below it commit. Deliberately not
      // the root: a click listener on the root would swallow every row tap, and
      // the row tap is the whole interaction model.
      views.setOnClickPendingIntent(
        R.id.atlas_v2_focus,
        PendingIntent.getActivity(
          context,
          widgetId,
          Intent(Intent.ACTION_VIEW, BOARD_URI).setPackage(context.packageName),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      return views
    }

    /**
     * The compact direction selector — TRANSIT.md §W1.
     *
     * Three chips rather than a dropdown, because the section asks for two
     * things a dropdown cannot give at once: the direction obvious at a glance,
     * and **one tap** back to AUTO.
     *
     * The options come down with the board (`selector.options`), so the words
     * for a direction are `@atlas/transit`'s and not a second set here. Before
     * the first board there is nothing to draw but AUTO, which is also the state
     * the instance is in.
     */
    private fun renderSelector(
      context: Context,
      res: Context,
      views: RemoteViews,
      widgetId: Int,
      board: JSONObject?,
      widthDp: Int,
    ) {
      views.removeAllViews(R.id.atlas_v2_selector)
      val selector = board?.optJSONObject("selector")
      val options = selector?.optJSONArray("options") ?: JSONArray()
      val active = selector?.string("mode").orEmpty().ifBlank {
        CommuteWidgetV2Store.selector(context, widgetId)
      }
      if (options.length() == 0) {
        val chip = RemoteViews(context.packageName, R.layout.atlas_commute_v2_chip)
        chip.setTextViewText(R.id.atlas_v2_chip, CommuteWidgetV2Store.SELECTOR_AUTO.uppercase())
        chip.setInt(R.id.atlas_v2_chip, "setBackgroundResource", R.drawable.atlas_v2_chip_on)
        chip.setTextColor(R.id.atlas_v2_chip, res.getColor(R.color.atlas_widget_accent))
        views.addView(R.id.atlas_v2_selector, chip)
        return
      }
      // A narrow instance drops the third chip's own word rather than letting
      // all three ellipsize into initials: AUTO and the direction you are *not*
      // on are what a tap needs, and the lit one is already named by the focus
      // line under it.
      val shown = if (widthDp < CHIPS_DP) minOf(options.length(), 2) else options.length()
      for (index in 0 until options.length()) {
        val option = options.optJSONObject(index) ?: continue
        val key = option.string("key")
        val lit = key == active
        // Never drop the lit chip: a selector that cannot show its own setting
        // is worse than one that shows two options instead of three.
        if (index >= shown && !lit) continue
        val chip = RemoteViews(context.packageName, R.layout.atlas_commute_v2_chip)
        chip.setTextViewText(R.id.atlas_v2_chip, option.string("short"))
        chip.setContentDescription(R.id.atlas_v2_chip, option.string("label"))
        chip.setInt(
          R.id.atlas_v2_chip,
          "setBackgroundResource",
          if (lit) R.drawable.atlas_v2_chip_on else R.drawable.atlas_v2_chip_off,
        )
        chip.setTextColor(
          R.id.atlas_v2_chip,
          res.getColor(if (lit) R.color.atlas_widget_accent else R.color.atlas_widget_muted),
        )
        chip.setOnClickPendingIntent(
          R.id.atlas_v2_chip,
          PendingIntent.getBroadcast(
            context,
            0,
            broadcast(context, widgetId, ACTION_SELECT, index).putExtra(EXTRA_SELECTOR, key),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          ),
        )
        views.addView(R.id.atlas_v2_selector, chip)
      }
    }

    /**
     * The focus — TRANSIT.md §W6's "next action first", in the order the section states
     * it: direction and state, then the action, then the time until it, then the
     * transfer information, then the detail.
     *
     * Every part is a field on `board.focus`; nothing here is derived. That is
     * what keeps the two axes separate: the phase chip and the direction line
     * are two fields, not one string with a special case per combination.
     */
    private fun renderFocus(
      res: Context,
      views: RemoteViews,
      focus: JSONObject?,
      widthDp: Int,
    ) {
      if (focus == null) {
        setText(views, R.id.atlas_v2_focus_phase, "")
        setText(views, R.id.atlas_v2_focus_direction, "")
        views.setTextViewText(
          R.id.atlas_v2_focus_action,
          res.getString(R.string.atlas_commute_v2_setup_action),
        )
        setText(views, R.id.atlas_v2_focus_when, "")
        setText(views, R.id.atlas_v2_focus_delay, "")
        setText(views, R.id.atlas_v2_focus_countdown, "")
        setText(views, R.id.atlas_v2_focus_platform, "")
        setText(views, R.id.atlas_v2_focus_detail, "")
        views.setViewVisibility(R.id.atlas_v2_focus_alert_row, View.GONE)
        return
      }
      val color = stateColor(res, focus.string("state"))
      setText(views, R.id.atlas_v2_focus_phase, focus.string("phaseLabel").uppercase())
      views.setTextColor(R.id.atlas_v2_focus_phase, color)
      setText(views, R.id.atlas_v2_focus_direction, focus.string("directionLabel"))
      views.setTextViewText(R.id.atlas_v2_focus_action, focus.string("action"))
      val when_ = focus.string("when")
      setText(views, R.id.atlas_v2_focus_when, when_)
      views.setTextColor(
        R.id.atlas_v2_focus_when,
        if (focus.string("state") == "cancelled") color
        else res.getColor(R.color.atlas_widget_text),
      )
      if (focus.string("state") == "cancelled" && when_.isNotBlank()) {
        views.setTextViewText(
          R.id.atlas_v2_focus_when,
          SpannableString(when_).apply { setSpan(StrikethroughSpan(), 0, length, 0) },
        )
      }
      val delay = focus.string("whenDelay")
      setText(views, R.id.atlas_v2_focus_delay, delay)
      if (delay.isNotBlank()) views.setTextColor(R.id.atlas_v2_focus_delay, color)
      setText(views, R.id.atlas_v2_focus_countdown, focus.string("countdown"))
      setText(
        views,
        R.id.atlas_v2_focus_platform,
        if (widthDp < NARROW_DP) "" else focus.string("platform"),
      )
      setText(views, R.id.atlas_v2_focus_detail, focus.string("detail"))
      val alert = focus.string("alert")
      setText(views, R.id.atlas_v2_focus_alert, alert)
      views.setViewVisibility(
        R.id.atlas_v2_focus_alert_row,
        if (alert.isBlank()) View.GONE else View.VISIBLE,
      )
      // Read out as one statement — "Engelsrud → Nationaltheatret · At
      // interchange · Change to 🚆 R14 07:41 · plat. 3 · 9 min · arrives 08:14"
      // — rather than as six unrelated fragments.
      views.setContentDescription(R.id.atlas_v2_focus, focus.string("text"))
    }

    /**
     * The line under the selector: what the widget is *doing* outranks how old
     * its answer is, and both outrank the board's own "Entur live · checked
     * 07:04", which is only true for as long as it is.
     */
    private fun statusLine(
      res: Context,
      context: Context,
      widgetId: Int,
      board: JSONObject?,
      nowMs: Long,
      widthDp: Int,
    ): Pair<CharSequence, Int> {
      val state = CommuteWidgetV2Store.state(context, widgetId)
      val stateAgeMs = nowMs - CommuteWidgetV2Store.stateAtMs(context, widgetId)
      if (state == CommuteWidgetV2Store.STATE_REFRESHING && stateAgeMs < REFRESHING_MS) {
        return Pair(
          res.getString(R.string.atlas_commute_v2_refreshing),
          res.getColor(R.color.atlas_widget_accent),
        )
      }
      if (state == CommuteWidgetV2Store.STATE_FAILED) {
        return Pair(
          res.getString(R.string.atlas_commute_v2_failed),
          res.getColor(R.color.atlas_widget_warn),
        )
      }
      if (board == null || state == CommuteWidgetV2Store.STATE_SETUP) {
        return Pair(
          res.getString(R.string.atlas_commute_v2_setup_status),
          res.getColor(R.color.atlas_widget_muted),
        )
      }
      val checkedMs = board.optLong("checkedMs")
      if (checkedMs > 0L && nowMs - checkedMs > STALE_MS) {
        // Aged locally, because the server cannot know how long its answer has
        // been sitting there.
        return Pair(
          res.getString(R.string.atlas_commute_v2_stale, board.string("checked")),
          res.getColor(R.color.atlas_widget_warn),
        )
      }
      val line = if (widthDp < NARROW_DP) board.string("source") else board.string("status")
      return Pair(
        line.ifBlank { board.string("status") },
        res.getColor(R.color.atlas_widget_muted),
      )
    }

    /**
     * One journey, and a control: a tap commits to it, and a tap on the one
     * already committed releases it (TRANSIT.md §W2 tier 1, §W3).
     *
     * The row's request code is derived from its own id rather than its
     * position, so the second row's intent stays about the 07:34 across a
     * refresh that reorders the list — a PendingIntent keyed on position would
     * commit to whatever happens to be second when the tap lands.
     */
    private fun rowViews(
      context: Context,
      res: Context,
      row: JSONObject,
      widgetId: Int,
      widthDp: Int,
      committedId: String,
    ): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.atlas_commute_v2_row)
      val cancelled = row.optBoolean("cancelled")
      val color = stateColor(res, row.string("state"))
      val id = row.string("id")
      val committed = id.isNotBlank() && id == committedId

      views.setViewVisibility(
        R.id.atlas_v2_row_mark,
        if (committed) View.VISIBLE else View.GONE,
      )
      val time = row.string("time")
      views.setTextViewText(
        R.id.atlas_v2_row_time,
        // Struck through rather than merely recoloured: colour alone is the one
        // distinction some readers do not get.
        if (cancelled) SpannableString(time).apply { setSpan(StrikethroughSpan(), 0, length, 0) }
        else time,
      )
      views.setTextColor(
        R.id.atlas_v2_row_time,
        when {
          cancelled -> color
          committed -> res.getColor(R.color.atlas_widget_accent)
          else -> res.getColor(R.color.atlas_widget_text)
        },
      )
      val delay = row.string("delayLabel")
      setText(views, R.id.atlas_v2_row_delay, delay)
      if (delay.isNotBlank()) {
        views.setTextColor(
          R.id.atlas_v2_row_delay,
          if (row.optBoolean("predictionInaccurate")) res.getColor(R.color.atlas_widget_muted)
          else color,
        )
      }
      val arrival = row.string("arrival")
      setText(views, R.id.atlas_v2_row_arrival, arrival)
      views.setViewVisibility(
        R.id.atlas_v2_row_arrow,
        if (arrival.isBlank()) View.GONE else View.VISIBLE,
      )
      setText(views, R.id.atlas_v2_row_lines, row.string("lines"))
      views.setTextColor(
        R.id.atlas_v2_row_lines,
        if (cancelled) res.getColor(R.color.atlas_widget_muted)
        else res.getColor(R.color.atlas_widget_text),
      )
      setText(
        views,
        R.id.atlas_v2_row_duration,
        if (widthDp < NARROW_DP) "" else row.string("duration"),
      )
      setText(
        views,
        R.id.atlas_v2_row_platform,
        if (widthDp < NARROW_DP) "" else row.string("platform"),
      )
      views.setContentDescription(R.id.atlas_v2_row_root, row.string("text"))
      if (id.isNotBlank()) {
        views.setOnClickPendingIntent(
          R.id.atlas_v2_row_root,
          PendingIntent.getBroadcast(
            context,
            0,
            broadcast(context, widgetId, ACTION_COMMIT, id.hashCode()).putExtra(EXTRA_COMMIT, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          ),
        )
      }
      return views
    }

    private fun setText(views: RemoteViews, id: Int, value: String?) {
      val text = value.orEmpty()
      views.setTextViewText(id, text)
      views.setViewVisibility(id, if (text.isEmpty()) View.GONE else View.VISIBLE)
    }
  }
}
