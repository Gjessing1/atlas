package io.gjessing.atlas.commutewidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray

/**
 * Which board *this* widget shows.
 *
 * The widget had no configuration of its own, so two instances could only ever
 * be the same widget twice — and the ⚙ that a launcher offers on a resize went
 * nowhere. One question, and every answer is one upstream call rather than two.
 *
 * The answers come in two groups, and the second is TRANSIT.md §5:
 *
 *  - **A direction** — the whole journey, door to door. The right board at 07:05.
 *  - **One leg of it** — "Asker stasjon → Nationaltheatret" and its next
 *    departures. The right board at 08:55, when you are already on the bus and
 *    the only open question is when the train leaves Asker. The panel puts these
 *    four boards a tab away; a home screen puts one of them at no taps at all,
 *    and a second instance can hold the leg after it.
 *
 * The legs are whatever `commuteSegments` said they are, handed over by
 * `configureCommuteWidget` with the commute: this screen lists them and stores
 * an id, and never works out what a corridor's legs are or what to call them.
 * A commute with no interchange has none, and the group is simply absent.
 *
 * Laid out in code deliberately: this is one list of rows, and an XML layout
 * plus a theme for a screen that exists for four taps a year would be more to
 * keep working than it is worth.
 */
class CommuteWidgetConfigureActivity : Activity() {
  private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    widgetId = intent?.extras?.getInt(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
    // A launcher placing a widget expects RESULT_CANCELED until the choice is
    // made: cancelling must leave no half-configured widget on the home screen.
    setResult(RESULT_CANCELED, resultIntent())

    val current = CommuteWidgetStore.direction(this, widgetId)
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(24), dp(20), dp(24))
    }
    root.addView(label("Which board?", 19f, TEXT, bold = true))
    root.addView(
      label(
        "Two widgets can show two boards of the same saved commute.",
        13f,
        MUTED,
      ).apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(14) },
    )
    for ((value, text) in OPTIONS) root.addView(option(value, text, current))

    // §5's boards, for the traveller already on one leg. Absent — not empty —
    // for a commute with no interchange: its only leg is the journey itself.
    val legs = segments()
    if (legs.isNotEmpty()) {
      root.addView(
        label("ONE LEG", 12f, MUTED, bold = true).apply {
          (layoutParams as LinearLayout.LayoutParams).topMargin = dp(18)
        },
      )
      root.addView(
        label(
          "The next departures on that leg only, with when they get in.",
          13f,
          MUTED,
        ).apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(6) },
      )
      for ((id, text) in legs) root.addView(option(id, text, current))
    }

    // A phone in a large font size runs out of screen at four directions plus
    // four legs, and a chooser whose last row cannot be reached is a chooser
    // that cannot be answered.
    setContentView(
      ScrollView(this).apply {
        setBackgroundColor(BACKGROUND)
        addView(root)
      },
    )
  }

  /** The hops as `configureCommuteWidget` stored them, or none. */
  private fun segments(): List<Pair<String, String>> {
    val raw = CommuteWidgetStore.segments(this) ?: return emptyList()
    val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
      val entry = array.optJSONObject(index) ?: return@mapNotNull null
      val id = entry.optString("id")
      val label = entry.optString("label")
      if (id.isBlank() || label.isBlank()) null else id to label
    }
  }

  private fun option(value: String, text: String, current: String): TextView =
    label(if (value == current) "●  $text" else "○  $text", 16f, TEXT).apply {
      setPadding(dp(4), dp(14), dp(4), dp(14))
      isClickable = true
      setOnClickListener { choose(value) }
    }

  private fun choose(direction: String) {
    if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
      val changed = direction != CommuteWidgetStore.direction(this, widgetId)
      CommuteWidgetStore.setDirection(this, widgetId, direction)
      // The rows on screen answer the *previous* question. Keeping them until
      // the new board lands would leave a widget titled "Engelsrud → Asker"
      // listing journeys to Nationaltheatret — the one failure a board like this
      // must not have. It says "Refreshing…" for the second or two instead.
      if (changed) {
        CommuteWidgetStore.clearBoard(this, widgetId)
        CommuteWidgetStore.setState(this, widgetId, CommuteWidgetStore.STATE_REFRESHING)
      }
      CommuteWidgetProvider.renderAll(this)
      CommuteWidgetProvider.refresh(this, widgetId)
    }
    setResult(RESULT_OK, resultIntent())
    finish()
  }

  private fun resultIntent() =
    Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)

  private fun label(text: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView =
    TextView(this).apply {
      this.text = text
      setTextColor(color)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
      gravity = Gravity.START
      if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      ).apply { bottomMargin = dp(2) }
    }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private companion object {
    private val BACKGROUND = Color.parseColor("#FF101418")
    private val TEXT = Color.WHITE
    private val MUTED = Color.parseColor("#FF9EABB9")

    /** The values `POST /api/transit/widget` accepts for `direction`. */
    val OPTIONS = listOf(
      CommuteWidgetStore.DIRECTION_AUTO to "Whichever is next (default)",
      "outbound" to "Outbound only",
      "inbound" to "Return only",
      "both" to "Both directions",
    )
  }
}
