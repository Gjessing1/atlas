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
     * The journey the *app's* board is tracking, pushed onto every v2 instance —
     * ROADMAP §6.4 §7's last piece.
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
