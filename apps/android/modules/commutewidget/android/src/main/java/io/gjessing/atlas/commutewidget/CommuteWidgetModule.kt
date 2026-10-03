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

    // Native V2 names and storage keys remain stable for existing pinned widgets.

    /**
     * The saved commute, for v2. No hop list: a v2 instance is never pointed at
     * one hop — it holds the whole commute and follows the leg you are on.
     */
    AsyncFunction("configureV2") { baseUrl: String, queryJson: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      CommuteWidgetStore.setBaseUrl(context, baseUrl)
      CommuteWidgetProvider.refresh(context, null)
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
     * The journey the *app's* board is tracking, pushed onto every v2 instance —
     * TRANSIT.md §7's last piece.
     *
     * A commitment is one fact with two hands on it: a tap on a widget row and
     * the Track control on the board mean the same thing, and until this existed
     * they were two independent facts that could disagree while both were
     * honest. Both write the same `{"direction","departureMs","line",
     * "committedAtMs"}` — the shape was shared from the start precisely so this
     * call could be a copy rather than a translation.
     *
     * Every instance, and `null` clears them all: the app holds *one*
     * commitment, so an instance keeping a different one would be a second
     * answer to "which bus am I on". Instances already holding the incoming
     * value are skipped rather than rewritten — the repaint is cheap but the
     * refresh behind it is somebody's Entur quota, and a commitment adopted
     * back out of this same store must not cost a round trip per widget. That
     * check is `sameCommit`, field by field: the two writers build the JSON in
     * different key orders and a textual comparison would call every push a
     * change.
     */
    AsyncFunction("setCommitV2") { commitJson: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      val changed =
        CommuteWidgetV2Provider.widgetIds(context).filter { id ->
          !CommuteWidgetV2Store.sameCommit(CommuteWidgetV2Store.commit(context, id), commitJson)
        }
      if (changed.isEmpty()) return@AsyncFunction
      changed.forEach { CommuteWidgetV2Store.setCommit(context, it, commitJson) }
      // Paint first, ask second — the same order a tap on the widget itself
      // uses. The mark has to move before the network is consulted, and the
      // board that confirms it is a round trip away.
      CommuteWidgetV2Provider.renderAll(context)
      changed.forEach { CommuteWidgetV2Provider.refresh(context, it) }
    }

    /**
     * The newest commitment any v2 instance holds, or null — the other
     * direction of the same fact, for a tap made on the home screen while the
     * app was closed.
     *
     * Newest by `committedAtMs`, because instances are peers: nothing makes one
     * widget's tap more current than another's except when it happened. The
     * *app* decides whether to adopt what comes back; this only reports.
     */
    AsyncFunction("commitV2") {
      val context = appContext.reactContext
      if (context == null) null
      else
        // `toList` first: `widgetIds` is an `IntArray`, and the primitive-array
        // overloads stop at `map`.
        CommuteWidgetV2Provider.widgetIds(context)
          .toList()
          .mapNotNull { CommuteWidgetV2Store.commit(context, it) }
          .maxByOrNull { CommuteWidgetV2Store.committedAtMs(it) }
    }

    /**
     * The coarse place the app observed while it was in the foreground — TRANSIT.md
     * §W2's cached fix, which may choose AUTO's *presentation* and nothing else.
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

    AsyncFunction("requestPinStop") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      val manager = AppWidgetManager.getInstance(context)
      if (!manager.isRequestPinAppWidgetSupported) return@AsyncFunction false
      manager.requestPinAppWidget(
        ComponentName(context, CommuteWidgetProvider::class.java),
        null,
        null,
      )
    }
  }
}
