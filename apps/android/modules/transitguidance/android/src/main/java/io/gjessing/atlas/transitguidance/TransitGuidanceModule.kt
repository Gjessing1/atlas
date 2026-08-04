package io.gjessing.atlas.transitguidance

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

private const val CHANNEL_ID = "atlas_transit_guidance"
private const val PREFS = "atlas_transit_guidance"
private const val COUNT = "alarm_count"

class TransitAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Transit guidance", NotificationManager.IMPORTANCE_HIGH)
      )
    }
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val content = launch?.let {
      PendingIntent.getActivity(
        context,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(intent.getStringExtra("title") ?: "Get off soon")
      .setContentText(intent.getStringExtra("body") ?: "Your stop is approaching.")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setVibrate(longArrayOf(0, 300, 150, 300))
      .apply { if (content != null) setContentIntent(content) }
      .build()
    manager.notify(intent.getIntExtra("notificationId", 0), notification)
  }
}

class TransitGuidanceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AtlasTransitGuidance")

    AsyncFunction("schedule") { alarmsJson: String ->
      val context = appContext.reactContext ?: return@AsyncFunction null
      cancelAll(context)
      val alarms = JSONArray(alarmsJson)
      val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      for (index in 0 until alarms.length()) {
        val alarm = alarms.getJSONObject(index)
        val intent = Intent(context, TransitAlarmReceiver::class.java)
          .putExtra("title", alarm.optString("title", "Get off soon"))
          .putExtra("body", alarm.optString("body", "Your stop is approaching."))
          .putExtra("notificationId", 7100 + index)
        val pending = PendingIntent.getBroadcast(
          context,
          7100 + index,
          intent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.getLong("triggerAtMs"), pending)
      }
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putInt(COUNT, alarms.length())
        .apply()
      null
    }

    AsyncFunction("cancel") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      cancelAll(context)
      null
    }
  }

  private fun cancelAll(context: Context) {
    val count = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(COUNT, 0)
    val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    for (index in 0 until count) {
      val pending = PendingIntent.getBroadcast(
        context,
        7100 + index,
        Intent(context, TransitAlarmReceiver::class.java),
        PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
      )
      if (pending != null) {
        manager.cancel(pending)
        pending.cancel()
      }
    }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(COUNT, 0).apply()
  }
}
