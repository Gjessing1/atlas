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
        CommuteWidgetStore.save(
          context,
          emptyList(),
          emptyList(),
          "Open Atlas to set up your commute",
        )
      }
      CommuteWidgetProvider.renderAll(context)
      CommuteWidgetProvider.schedule(context)
      CommuteWidgetProvider.refresh(context)
    }
  }
}
