package io.gjessing.atlas.commutewidget

import android.content.Context

internal object CommuteWidgetStore {
  private const val PREFS = "atlas_commute_widget"
  private const val BASE_URL = "base_url"
  private const val QUERY = "query"
  private const val OUTBOUND_1 = "outbound_1"
  private const val OUTBOUND_2 = "outbound_2"
  private const val INBOUND_1 = "inbound_1"
  private const val INBOUND_2 = "inbound_2"
  private const val STATUS = "status"

  data class Snapshot(
    val outbound: List<String>,
    val inbound: List<String>,
    val status: String,
  )

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configure(context: Context, baseUrl: String, query: String?) {
    prefs(context).edit()
      .putString(BASE_URL, baseUrl.trimEnd('/'))
      .apply {
        if (query == null) remove(QUERY) else putString(QUERY, query)
      }
      .apply()
  }

  fun baseUrl(context: Context): String? = prefs(context).getString(BASE_URL, null)
  fun query(context: Context): String? = prefs(context).getString(QUERY, null)

  fun save(context: Context, outbound: List<String>, inbound: List<String>, status: String) {
    prefs(context).edit()
      .putString(OUTBOUND_1, outbound.getOrNull(0).orEmpty())
      .putString(OUTBOUND_2, outbound.getOrNull(1).orEmpty())
      .putString(INBOUND_1, inbound.getOrNull(0).orEmpty())
      .putString(INBOUND_2, inbound.getOrNull(1).orEmpty())
      .putString(STATUS, status)
      .apply()
  }

  fun snapshot(context: Context): Snapshot {
    val saved = prefs(context)
    return Snapshot(
      listOf(
        saved.getString(OUTBOUND_1, "").orEmpty(),
        saved.getString(OUTBOUND_2, "").orEmpty(),
      ),
      listOf(
        saved.getString(INBOUND_1, "").orEmpty(),
        saved.getString(INBOUND_2, "").orEmpty(),
      ),
      saved.getString(STATUS, "Open Atlas to set up your commute").orEmpty(),
    )
  }
}
