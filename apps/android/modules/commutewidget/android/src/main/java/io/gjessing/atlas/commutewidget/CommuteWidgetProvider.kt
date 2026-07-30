package io.gjessing.atlas.commutewidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class CommuteWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    renderAll(context)
    schedule(context)
    refresh(context)
  }

  override fun onEnabled(context: Context) {
    schedule(context)
    refresh(context)
  }

  override fun onDisabled(context: Context) {
    WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) refresh(context)
  }

  companion object {
    const val ACTION_REFRESH = "io.gjessing.atlas.commutewidget.REFRESH"
    private const val PERIODIC_WORK = "atlas-commute-widget-periodic"
    private const val IMMEDIATE_WORK = "atlas-commute-widget-now"

    private fun constraints() =
      Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun hasWidgets(context: Context): Boolean =
      AppWidgetManager.getInstance(context)
        .getAppWidgetIds(ComponentName(context, CommuteWidgetProvider::class.java))
        .isNotEmpty()

    fun schedule(context: Context) {
      if (!hasWidgets(context)) return
      val work = PeriodicWorkRequestBuilder<CommuteWidgetWorker>(15, TimeUnit.MINUTES)
        .setConstraints(constraints())
        .build()
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        PERIODIC_WORK,
        ExistingPeriodicWorkPolicy.UPDATE,
        work,
      )
    }

    fun refresh(context: Context) {
      if (!hasWidgets(context)) return
      val work = OneTimeWorkRequestBuilder<CommuteWidgetWorker>()
        .setConstraints(constraints())
        .build()
      WorkManager.getInstance(context).enqueueUniqueWork(
        IMMEDIATE_WORK,
        ExistingWorkPolicy.REPLACE,
        work,
      )
    }

    fun renderAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, CommuteWidgetProvider::class.java))
      val query = CommuteWidgetStore.query(context)
      val snapshot = CommuteWidgetStore.snapshot(context)
      val names = CommuteWidgetWorker.routeNames(query)
      ids.forEach { id ->
        val views = RemoteViews(context.packageName, R.layout.atlas_commute_widget)
        views.setTextViewText(R.id.atlas_commute_title, "Atlas commute")
        views.setTextViewText(
          R.id.atlas_commute_route,
          names ?: "Choose favorites in Atlas",
        )
        setRow(views, R.id.atlas_commute_outbound_1, snapshot.outbound.getOrNull(0))
        setRow(views, R.id.atlas_commute_outbound_2, snapshot.outbound.getOrNull(1))
        setRow(views, R.id.atlas_commute_inbound_1, snapshot.inbound.getOrNull(0))
        setRow(views, R.id.atlas_commute_inbound_2, snapshot.inbound.getOrNull(1))
        views.setTextViewText(R.id.atlas_commute_status, snapshot.status)

        val refreshIntent = Intent(context, CommuteWidgetProvider::class.java).apply {
          action = ACTION_REFRESH
        }
        views.setOnClickPendingIntent(
          R.id.atlas_commute_refresh,
          PendingIntent.getBroadcast(
            context,
            0,
            refreshIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          ),
        )
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
          views.setOnClickPendingIntent(
            R.id.atlas_commute_widget_root,
            PendingIntent.getActivity(
              context,
              0,
              launch,
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
          )
        }
        manager.updateAppWidget(id, views)
      }
    }

    private fun setRow(views: RemoteViews, id: Int, value: String?) {
      val text = value.orEmpty()
      views.setTextViewText(id, text)
      views.setViewVisibility(id, if (text.isEmpty()) View.GONE else View.VISIBLE)
    }
  }
}
