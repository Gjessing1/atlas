package io.gjessing.atlas.commutewidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import io.gjessing.atlas.commutewidget.v2.CommuteWidgetV2Provider
import io.gjessing.atlas.commutewidget.v2.CommuteWidgetV2Store

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

    // ------------------------------------------------------------ v2 ---
    //
    // ROADMAP §6.5. The **v2** widget is a second widget, not a new version of
    // the one above: v1 pins a *board* and stays the fallback, v2 pins the
    // *commute*. It keeps its own store, so these are separate functions rather
    // than a flag — configuring one must never touch the other's state.

    /**
     * The saved commute, for v2. No hop list: a v2 instance is never pointed at
     * one hop — it holds the whole commute and follows the leg you are on.
     */
    AsyncFunction("configureV2") { baseUrl: String, queryJson: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      CommuteWidgetV2Store.configure(context, baseUrl, queryJson)
      if (queryJson == null) {
        for (id in CommuteWidgetV2Provider.widgetIds(context)) {
          CommuteWidgetV2Store.clearBoard(context, id)
          CommuteWidgetV2Store.setState(context, id, CommuteWidgetV2Store.STATE_SETUP)
        }
      }
      CommuteWidgetV2Provider.renderAll(context)
      CommuteWidgetV2Provider.refresh(context, null)
    }

    /**
     * The coarse place the app observed while it was in the foreground — §6.5
     * §2's cached fix, which may choose AUTO's *presentation* and nothing else.
     *
     * Written by the app because the widget cannot honestly read one: a refresh
     * runs in a WorkManager job with no foreground service, where Android
     * throttles background location to nothing useful. Which place a position
     * *is* — home, interchange, away — is decided by `@atlas/transit`, not here.
     */
    AsyncFunction("setPlace") { place: String ->
      val context = appContext.reactContext ?: return@AsyncFunction
      CommuteWidgetV2Store.setPlace(context, place)
    }

    AsyncFunction("supportV2") {
      val context = appContext.reactContext
      val manager = context?.let { AppWidgetManager.getInstance(it) }
      val pinnable =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          manager?.isRequestPinAppWidgetSupported == true
      mapOf(
        "pinnable" to pinnable,
        "count" to (context?.let { CommuteWidgetV2Provider.widgetIds(it).size } ?: 0),
      )
    }

    AsyncFunction("requestPinV2") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      val manager = AppWidgetManager.getInstance(context)
      if (!manager.isRequestPinAppWidgetSupported) return@AsyncFunction false
      val extras = Bundle()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        extras.putParcelable(
          AppWidgetManager.EXTRA_APPWIDGET_PREVIEW,
          CommuteWidgetV2Provider.previewViews(context),
        )
      }
      manager.requestPinAppWidget(
        ComponentName(context, CommuteWidgetV2Provider::class.java),
        extras,
        null,
      )
    }
  }
}
