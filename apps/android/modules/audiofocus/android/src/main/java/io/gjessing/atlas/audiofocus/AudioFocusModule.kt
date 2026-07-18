package io.gjessing.atlas.audiofocus

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Transient AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK holder for voice guidance:
 * well-behaved media apps lower their volume while we hold it and restore it
 * on abandon. Attributed as navigation-guidance speech so the system routes
 * the ducking decision correctly (Android O+ does the ducking itself).
 */
class AudioFocusModule : Module() {
  private var focusRequest: AudioFocusRequest? = null

  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("AudioFocus")

    Function("requestDuck") {
      val am = audioManager ?: return@Function false
      val granted =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val request =
            focusRequest
              ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(
                  AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                )
                .build()
                .also { focusRequest = it }
          am.requestAudioFocus(request)
        } else {
          @Suppress("DEPRECATION")
          am.requestAudioFocus(
            null,
            AudioManager.STREAM_MUSIC,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
          )
        }
      granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    Function("abandon") {
      val am = audioManager
      if (am != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          focusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
          @Suppress("DEPRECATION") am.abandonAudioFocus(null)
        }
      }
    }
  }
}
