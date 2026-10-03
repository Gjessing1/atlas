package io.gjessing.atlas.commutewidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/** Launcher configuration for one exact stop and, optionally, one line at it. */
class CommuteWidgetConfigureActivity : Activity() {
  private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private lateinit var root: LinearLayout
  private var selectedStop: JSONObject? = null
  private val origin: String
    get() = CommuteWidgetStore.baseUrl(this) ?: "https://atlas.gjessing.io"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    widgetId = intent?.getIntExtra(
      AppWidgetManager.EXTRA_APPWIDGET_ID,
      AppWidgetManager.INVALID_APPWIDGET_ID,
    ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
    setResult(RESULT_CANCELED, resultIntent())
    root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(24), dp(20), dp(24))
    }
    setContentView(ScrollView(this).apply {
      setBackgroundColor(BACKGROUND)
      addView(root)
    })
    selectedStop = CommuteWidgetStore.stop(this, widgetId)?.let {
      runCatching { JSONObject(it) }.getOrNull()
    }
    showSearch()
  }

  private fun showSearch() {
    root.removeAllViews()
    root.addView(label("Choose a departure stop", 20f, TEXT, true))
    selectedStop?.let { root.addView(label("Current: ${it.optString("name")}", 14f, MUTED)) }
    val input = EditText(this).apply {
      id = R.id.atlas_stop_widget_search
      contentDescription = "Stop search"
      hint = "Search for a stop…"
      setSingleLine(true)
      imeOptions = EditorInfo.IME_ACTION_SEARCH
      setTextColor(TEXT)
      setHintTextColor(MUTED)
    }
    root.addView(input)
    val results = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    root.addView(option("Search stops") { search(input.text.toString(), results) })
    root.addView(results)
    selectedStop?.let { stop ->
      root.addView(option("Keep ${stop.optString("name")}") { showLines(stop) })
    }
    input.setOnEditorActionListener { _, _, _ ->
      search(input.text.toString(), results)
      true
    }
  }

  private fun search(query: String, results: LinearLayout) {
    results.removeAllViews()
    if (query.trim().length < 2) {
      results.addView(label("Enter at least two characters.", 14f, MUTED))
      return
    }
    results.addView(label("Searching…", 14f, MUTED))
    load("/api/transit/stops?q=${java.net.URLEncoder.encode(query.trim(), "UTF-8")}&limit=10", {
      results.removeAllViews()
      val hits = it.optJSONArray("results") ?: JSONArray()
      if (hits.length() == 0) results.addView(label("No stops found.", 14f, MUTED))
      for (index in 0 until hits.length()) {
        val hit = hits.optJSONObject(index) ?: continue
        val id = hit.optString("transitStopId")
        val name = hit.optString("name")
        val position = hit.optJSONObject("position") ?: continue
        val lat = position.optDouble("lat", Double.NaN)
        val lng = position.optDouble("lng", Double.NaN)
        if (!id.startsWith("NSR:StopPlace:") || name.isBlank() || !lat.isFinite() || !lng.isFinite()) continue
        val stop = JSONObject().put("stopId", id).put("lat", lat).put("lng", lng).put("name", name)
        results.addView(option("$name  ·  ${hit.optString("label")}") { showLines(stop) })
      }
    }, { message ->
      results.removeAllViews()
      results.addView(label("Stop search unavailable: $message", 14f, MUTED))
    })
  }

  private fun showLines(stop: JSONObject) {
    selectedStop = stop
    root.removeAllViews()
    root.addView(label(stop.optString("name"), 20f, TEXT, true))
    root.addView(label("All lines, or choose one line for this widget.", 14f, MUTED))
    root.addView(option("All lines") { save(stop, null, null) })
    val results = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    results.addView(label("Loading lines…", 14f, MUTED))
    root.addView(results)
    root.addView(option("← Change stop") { showSearch() })
    load("/api/transit/stop-lines?stopId=${java.net.URLEncoder.encode(stop.optString("stopId"), "UTF-8")}", {
      results.removeAllViews()
      val lines = it.optJSONArray("lines") ?: JSONArray()
      if (lines.length() == 0) results.addView(label("No lines found; choose all lines.", 14f, MUTED))
      for (index in 0 until lines.length()) {
        val line = lines.optJSONObject(index) ?: continue
        val id = line.optString("id")
        if (id.isBlank()) continue
        val code = line.optString("publicCode")
        val name = line.optString("name")
        results.addView(option("$code  ·  $name") { save(stop, id, code) })
      }
    }, { message ->
      results.removeAllViews()
      results.addView(label("Lines unavailable: $message. All lines still works.", 14f, MUTED))
    })
  }

  private fun save(stop: JSONObject, lineId: String?, lineLabel: String?) {
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return
    CommuteWidgetStore.setStop(this, widgetId, stop.toString(), lineId, lineLabel)
    CommuteWidgetStore.setState(this, widgetId, CommuteWidgetStore.STATE_REFRESHING)
    CommuteWidgetProvider.renderAll(this)
    CommuteWidgetProvider.refresh(this, widgetId)
    setResult(RESULT_OK, resultIntent())
    finish()
  }

  private fun load(path: String, success: (JSONObject) -> Unit, failure: (String) -> Unit) {
    Thread {
      val answer = runCatching {
        val connection = URL("$origin$path").openConnection() as HttpURLConnection
        connection.connectTimeout = 5_000
        connection.readTimeout = 10_000
        try {
          if (connection.responseCode !in 200..299) error("HTTP ${connection.responseCode}")
          JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
          connection.disconnect()
        }
      }
      runOnUiThread {
        if (!isFinishing && !isDestroyed) answer.fold(success, { failure(it.message ?: "network error") })
      }
    }.start()
  }

  private fun resultIntent() = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)

  private fun option(text: String, action: () -> Unit): TextView =
    label(text, 16f, TEXT).apply {
      setPadding(dp(4), dp(14), dp(4), dp(14))
      isClickable = true
      setOnClickListener { action() }
    }

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
  }
}
