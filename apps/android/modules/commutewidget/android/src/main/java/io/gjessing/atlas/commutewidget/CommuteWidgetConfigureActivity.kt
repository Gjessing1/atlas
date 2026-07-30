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
import android.widget.TextView

/**
 * Which direction *this* widget shows.
 *
 * The widget had no configuration of its own, so two instances could only ever
 * be the same widget twice — and the ⚙ that a launcher offers on a resize went
 * nowhere. One question, four answers, and each is one upstream call rather than
 * two, since a widget asking for one direction does not need the other.
 *
 * Laid out in code deliberately: this is one list of four rows, and an XML layout
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
      setBackgroundColor(Color.parseColor("#FF101418"))
      setPadding(dp(20), dp(24), dp(20), dp(24))
    }
    root.addView(label("Which way?", 19f, Color.WHITE, bold = true))
    root.addView(
      label(
        "Two widgets can show two directions of the same saved commute.",
        13f,
        Color.parseColor("#FF9EABB9"),
      ).apply { (layoutParams as LinearLayout.LayoutParams).bottomMargin = dp(14) },
    )
    for ((value, text) in OPTIONS) {
      root.addView(
        label(
          if (value == current) "●  $text" else "○  $text",
          16f,
          Color.WHITE,
        ).apply {
          setPadding(dp(4), dp(14), dp(4), dp(14))
          isClickable = true
          setOnClickListener { choose(value) }
        },
      )
    }
    setContentView(root)
  }

  private fun choose(direction: String) {
    if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
      CommuteWidgetStore.setDirection(this, widgetId, direction)
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
    /** The values `POST /api/transit/widget` accepts for `direction`. */
    val OPTIONS = listOf(
      CommuteWidgetStore.DIRECTION_AUTO to "Whichever is next (default)",
      "outbound" to "Outbound only",
      "inbound" to "Return only",
      "both" to "Both directions",
    )
  }
}
