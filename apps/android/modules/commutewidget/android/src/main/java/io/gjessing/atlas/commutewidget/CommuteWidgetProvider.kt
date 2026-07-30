package io.gjessing.atlas.commutewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Paints the widget from the board the backend rendered, and decides when to ask
 * for the next one.
 *
 * Everything here is per instance. Two widgets can show two directions (⚙), each
 * keeps its own last-good board, and each schedules its own next refresh — where
 * the previous version had one global snapshot and one 15-minute
 * `PeriodicWorkRequest` for all of them.
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

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) {
      val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
      refresh(context, if (id >= 0) id else null)
    }
  }

  companion object {
    const val ACTION_REFRESH = "io.gjessing.atlas.commutewidget.REFRESH"
    private const val BLOCKS = 2

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

    private fun render(context: Context, widgetId: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.atlas_commute_widget)
      val board = CommuteWidgetStore.board(context, widgetId)?.let {
        runCatching { JSONObject(it) }.getOrNull()
      }
      views.setTextViewText(R.id.atlas_commute_title, "Atlas commute")
      views.setTextViewText(
        R.id.atlas_commute_route,
        board?.optString("route").takeUnless { it.isNullOrBlank() } ?: "Choose your stops in Atlas",
      )

      val directions = board?.optJSONArray("directions")
      for (block in 0 until BLOCKS) {
        val direction = directions?.optJSONObject(block)
        views.setViewVisibility(blockId(block), if (direction == null) View.GONE else View.VISIBLE)
        if (direction == null) continue
        views.setTextViewText(labelId(block), direction.optString("label").uppercase())
        val rows = direction.optJSONArray("rows")
        val note = direction.optString("note").orEmpty()
        for (row in 0 until CommuteWidgetWorker.ROWS_PER_DIRECTION) {
          // A direction with no rows says why in its first slot, instead of
          // collapsing to an empty block that reads as a broken widget.
          val text = rows?.optJSONObject(row)?.optString("text").orEmpty()
          setRow(views, rowId(block, row), if (row == 0 && text.isEmpty()) note else text)
        }
      }

      views.setTextViewText(
        R.id.atlas_commute_status,
        CommuteWidgetStore.status(context, widgetId)
          ?: board?.optString("status").takeUnless { it.isNullOrBlank() }
          ?: "Open Atlas to set up your commute",
      )

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

    private fun blockId(block: Int) =
      if (block == 0) R.id.atlas_commute_block_1 else R.id.atlas_commute_block_2

    private fun labelId(block: Int) =
      if (block == 0) R.id.atlas_commute_label_1 else R.id.atlas_commute_label_2

    private fun rowId(block: Int, row: Int): Int =
      if (block == 0) {
        when (row) {
          0 -> R.id.atlas_commute_row_1_1
          1 -> R.id.atlas_commute_row_1_2
          else -> R.id.atlas_commute_row_1_3
        }
      } else {
        when (row) {
          0 -> R.id.atlas_commute_row_2_1
          1 -> R.id.atlas_commute_row_2_2
          else -> R.id.atlas_commute_row_2_3
        }
      }

    private fun setRow(views: RemoteViews, id: Int, value: String?) {
      val text = value.orEmpty()
      views.setTextViewText(id, text)
      views.setViewVisibility(id, if (text.isEmpty()) View.GONE else View.VISIBLE)
    }
  }
}
