package io.gjessing.atlas.valhalla

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Expo bridge to the embedded Valhalla routing engine (valhalla_jni.cpp).
 * AsyncFunction bodies run off the JS thread, so a slow route computation
 * never blocks the UI; the native side serializes engine access itself.
 */
class ValhallaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Valhalla")

    AsyncFunction("open") { configJson: String ->
      nativeOpen(configJson)
    }

    AsyncFunction("route") { requestJson: String ->
      nativeRoute(requestJson)
    }

    AsyncFunction("traceAttributes") { requestJson: String ->
      nativeTraceAttributes(requestJson)
    }

    AsyncFunction("close") {
      nativeClose()
    }
  }

  private external fun nativeOpen(configJson: String)
  private external fun nativeRoute(requestJson: String): String
  private external fun nativeTraceAttributes(requestJson: String): String
  private external fun nativeClose()

  companion object {
    init {
      System.loadLibrary("valhalla_jni")
    }
  }
}
