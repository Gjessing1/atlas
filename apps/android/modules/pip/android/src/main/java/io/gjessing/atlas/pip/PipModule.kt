package io.gjessing.atlas.pip

import android.app.Activity
import android.app.AppOpsManager
import android.app.PictureInPictureParams
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Rect
import android.os.Build
import android.util.Rational
import android.view.View
import androidx.activity.ComponentActivity
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * Picture-in-picture for active navigation: leaving Atlas mid-trip shrinks it
 * into a floating mini window instead of hiding guidance completely.
 *
 * This owns nothing about the trip — it only tells the system that the activity
 * may go into PiP while guidance is running, and tells React when it did. The
 * location foreground service, the voice prompts and the navigation session are
 * untouched: PiP is another presentation of the same trip, never a second
 * navigation implementation.
 *
 * On Android 12+ the smooth transition comes from `setAutoEnterEnabled`, so the
 * system enters PiP itself on the Home gesture. Android 8–11 have no such flag
 * and must enter from the "user is leaving" callback.
 */
class PipModule : Module() {
  /** True while guidance wants the mini window (and the user has it enabled). */
  private var active = false
  /** The activity whose PiP parameters most recently accepted `active`. */
  private var appliedTo = WeakReference<ComponentActivity>(null)
  private var listeningTo = WeakReference<ComponentActivity>(null)
  /**
   * Where on screen the content that continues in the mini window is drawn —
   * the map viewport, measured by React as it lays out. The system follows this
   * rectangle into the floating window, matching the content that remains.
   */
  private var sourceRect: Rect? = null

  private val activity: Activity?
    get() = appContext.activityProvider?.currentActivity

  override fun definition() = ModuleDefinition {
    Name("AtlasPip")
    Events(CHANGE_EVENT)

    /** Whether this device has picture-in-picture at all. */
    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        appContext.reactContext
          ?.packageManager
          ?.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) == true
    }

    /**
     * Whether PiP is permitted for Atlas. Users can switch it off per app in
     * system settings, and a mini window that silently never appears is worth
     * explaining rather than leaving as a dead toggle.
     */
    Function("isAllowed") { allowed() }

    /**
     * Arm or disarm entering PiP. Called with true while guidance is actively
     * navigating and the setting is on, and with false the moment the trip ends
     * — so an ended trip can never leave an idle Atlas window floating.
     */
    Function("setActive") { on: Boolean ->
      active = on
      applyToCurrentActivity()
      active && appliedTo.get() != null
    }

    /** The applied state, not merely the last state requested by JavaScript. */
    Function("isArmed") { active && appliedTo.get() === activity }

    /**
     * Point the shrink animation at the map viewport (device pixels, window
     * coordinates). A width of 0 clears it, falling back to the whole content
     * view. Params are re-applied straight away so the hint is already current
     * when the system enters PiP by itself on Android 12+.
     */
    Function("setSourceRect") { x: Int, y: Int, width: Int, height: Int ->
      val next = if (width > 0 && height > 0) Rect(x, y, x + width, y + height) else null
      if (next == sourceRect) return@Function
      sourceRect = next
      val current = activity as? ComponentActivity ?: return@Function
      if (!active) return@Function
      current.runOnUiThread {
        try {
          current.setPictureInPictureParams(
            params(current, autoEnter = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
          )
        } catch (err: IllegalStateException) {
          // Finishing activity — the next setActive will carry the rect.
        }
      }
    }

    /** Whether the activity is in PiP right now (for the first render). */
    Function("inPictureInPicture") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity?.isInPictureInPictureMode == true
    }

    // Auto-enter is the smooth path on Android 12+, but it is not a guarantee:
    // an activity attach/resume can race the parameters being applied. Keep the
    // guarded manual path on every supported version so the first Home press
    // still works when that race loses.
    OnUserLeavesActivity {
      if (!active) return@OnUserLeavesActivity
      val current = activity ?: return@OnUserLeavesActivity
      if (current.isInPictureInPictureMode) return@OnUserLeavesActivity
      val enterIfStillNeeded = {
        if (active && !current.isFinishing && !current.isInPictureInPictureMode) {
          try {
            @Suppress("DEPRECATION")
            current.enterPictureInPictureMode(params(current, autoEnter = false))
          } catch (err: IllegalStateException) {
            // PiP refused (disabled for the app, or the activity is finishing):
            // guidance carries on in the notification and by voice, as before.
          }
        }
      }
      // Give Android 12+'s smooth auto-enter path one frame to win. Older
      // versions have no auto-enter and use the manual path immediately.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        current.window.decorView.postDelayed(enterIfStillNeeded, 200)
      } else current.runOnUiThread(enterIfStillNeeded)
    }

    // `active` is desired trip state and deliberately survives activity
    // recreation. Re-apply it whenever Expo attaches/resumes the replacement
    // activity; a transiently-null currentActivity therefore heals itself.
    OnActivityEntersForeground { applyToCurrentActivity() }

    OnActivityDestroys {
      sourceRect = null
      appliedTo.clear()
      listeningTo.clear()
    }
  }

  /**
   * Hear about PiP transitions through the activity's own callback rather than
   * by overriding the generated MainActivity.
   */
  private fun listen(current: ComponentActivity) {
    if (listeningTo.get() === current) return
    listeningTo = WeakReference(current)
    current.runOnUiThread {
      current.addOnPictureInPictureModeChangedListener { info ->
        sendEvent(CHANGE_EVENT, mapOf("inPictureInPicture" to info.isInPictureInPictureMode))
      }
    }
  }

  private fun applyToCurrentActivity() {
    val current = activity as? ComponentActivity ?: run {
      appliedTo.clear()
      return
    }
    listen(current)
    current.runOnUiThread {
      try {
        current.setPictureInPictureParams(
          params(current, autoEnter = active && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
        )
        if (active) appliedTo = WeakReference(current) else appliedTo.clear()
      } catch (err: IllegalStateException) {
        appliedTo.clear()
      }
    }
  }

  /**
   * A 16:9 window that flies out of the map viewport it continues to show,
   * falling back to the whole content view before React has measured it. The
   * live map resizes cleanly, so seamless resize avoids a stale cropped
   * snapshot while React commits the compact guidance strip.
   */
  private fun params(current: Activity, autoEnter: Boolean): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
    (sourceRect ?: contentRect(current))?.let { builder.setSourceRectHint(it) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(autoEnter)
      builder.setSeamlessResizeEnabled(true)
    }
    return builder.build()
  }

  private fun contentRect(current: Activity): Rect? {
    val view: View = current.findViewById(android.R.id.content) ?: return null
    if (view.width == 0 || view.height == 0) return null
    val at = IntArray(2)
    view.getLocationInWindow(at)
    return Rect(at[0], at[1], at[0] + view.width, at[1] + view.height)
  }

  private fun allowed(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val context = appContext.reactContext ?: return false
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
    val mode =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ops.unsafeCheckOpNoThrow(
          AppOpsManager.OPSTR_PICTURE_IN_PICTURE,
          android.os.Process.myUid(),
          context.packageName,
        )
      } else {
        @Suppress("DEPRECATION")
        ops.checkOpNoThrow(
          AppOpsManager.OPSTR_PICTURE_IN_PICTURE,
          android.os.Process.myUid(),
          context.packageName,
        )
      }
    return mode == AppOpsManager.MODE_ALLOWED
  }

  companion object {
    private const val CHANGE_EVENT = "onPictureInPictureChange"
  }
}
