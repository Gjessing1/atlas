package io.gjessing.atlas.commutewidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CommuteWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AtlasCommuteWidget")

    AsyncFunction("configure") { baseUrl: String, queryJson: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction
      CommuteWidgetStore.configure(context, baseUrl, queryJson)
      if (queryJson == null) {
        // No commute saved: say so on every instance, and drop the stale boards
        // rather than leaving yesterday's departures next to that sentence.
        for (id in CommuteWidgetProvider.widgetIds(context)) {
          CommuteWidgetStore.clearBoard(context, id)
          CommuteWidgetStore.saveStatus(context, id, "Open Atlas to set up your commute")
        }
      }
      CommuteWidgetProvider.renderAll(context)
      CommuteWidgetProvider.refresh(context, null)
    }
  }
}
