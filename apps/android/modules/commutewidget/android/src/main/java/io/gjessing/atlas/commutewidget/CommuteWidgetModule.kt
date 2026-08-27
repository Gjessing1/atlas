package io.gjessing.atlas.commutewidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CommuteWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AtlasCommuteWidget")

    /**
     * The saved commute, plus the hops it generates — `[{"id","label"}, …]` as
     * `commuteSegments` derived them, so the ⚙ screen can offer one leg's board
     * without a Kotlin copy of that derivation.
     */
    AsyncFunction("configure") { baseUrl: String, queryJson: String?, segmentsJson: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      CommuteWidgetStore.configure(context, baseUrl, queryJson, segmentsJson)
      if (queryJson == null) {
        // No commute saved: say so on every instance, and drop the stale boards
        // rather than leaving yesterday's departures next to that sentence.
        for (id in CommuteWidgetProvider.widgetIds(context)) {
          CommuteWidgetStore.clearBoard(context, id)
          CommuteWidgetStore.setState(context, id, CommuteWidgetStore.STATE_SETUP)
        }
      }
      CommuteWidgetProvider.renderAll(context)
      CommuteWidgetProvider.refresh(context, null)
    }

    /**
     * What the commute sheet needs to offer "Add to home screen": whether this
     * launcher takes pin requests at all (many do; some, and every launcher
     * before Android 8, do not), and how many instances are already out there.
     *
     * Asking Android rather than assuming is the whole point — an "Add widget"
     * button that silently does nothing is worse than no button.
     */
    AsyncFunction("support") {
      val context = appContext.reactContext
      val manager = context?.let { AppWidgetManager.getInstance(it) }
      val pinnable =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          manager?.isRequestPinAppWidgetSupported == true
      mapOf(
        "pinnable" to pinnable,
        "count" to (context?.let { CommuteWidgetProvider.widgetIds(it).size } ?: 0),
      )
    }

    /**
     * Ask the launcher to place one. It shows its own confirmation — with the
     * populated preview on Android 12+ — and never runs the configuration
     * activity, so the instance lands on the "whichever is next" default and
     * fills itself in from `onUpdate`.
     */
    AsyncFunction("requestPin") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      val manager = AppWidgetManager.getInstance(context)
      if (!manager.isRequestPinAppWidgetSupported) return@AsyncFunction false
      val extras = Bundle()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        extras.putParcelable(
          AppWidgetManager.EXTRA_APPWIDGET_PREVIEW,
          CommuteWidgetProvider.previewViews(context),
        )
      }
      manager.requestPinAppWidget(
        ComponentName(context, CommuteWidgetProvider::class.java),
        extras,
        null,
      )
    }
  }
}
