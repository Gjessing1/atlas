package io.gjessing.atlas.pip

import android.app.Activity
import android.app.AppOpsManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.provider.Settings
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
  /** The action label/icon follows the same mute state as the full banner. */
  private var muted = false
  private var receiverRegistered = false

  private val actionReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        when (intent?.action) {
          ACTION_TOGGLE_MUTE -> sendEvent(ACTION_EVENT, mapOf("action" to "toggleMute"))
          ACTION_END_TRIP -> sendEvent(ACTION_EVENT, mapOf("action" to "endTrip"))
        }
      }
    }

  private val activity: Activity?
    get() = appContext.activityProvider?.currentActivity

  override fun definition() = ModuleDefinition {
    Name("AtlasPip")
    Events(CHANGE_EVENT, ACTION_EVENT)

    OnCreate { registerActionReceiver() }

    OnDestroy {
      if (receiverRegistered) {
        runCatching { appContext.reactContext?.unregisterReceiver(actionReceiver) }
        receiverRegistered = false
      }
    }

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

    /** Keep the system action in sync with the banner's persisted voice state. */
    Function("setMuted") { on: Boolean ->
      muted = on
      if (active) applyToCurrentActivity()
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

    /**
     * The current activity window in dp. React Native's window event was
     * measured returning the PiP task's physical pixel bounds on Android 16,
     * even though Yoga continued to size views in dp. Read the task window
     * itself and normalize it by density: the resources configuration can
     * still describe the old full-screen window during the first PiP render.
     */
    Function("windowSize") {
      val current = activity
      val resources = current?.resources ?: appContext.reactContext?.resources
      val configuration = resources?.configuration ?: return@Function null
      val density = resources.displayMetrics.density
      val bounds =
        when {
          current == null -> null
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ->
            current.windowManager.currentWindowMetrics.bounds
          current.window.decorView.width > 0 && current.window.decorView.height > 0 ->
            Rect(0, 0, current.window.decorView.width, current.window.decorView.height)
          else -> null
        }
      mapOf(
        "width" to (bounds?.let { Math.round(it.width() / density) } ?: configuration.screenWidthDp),
        "height" to
          (bounds?.let { Math.round(it.height() / density) } ?: configuration.screenHeightDp),
      )
    }

    /** Whether the activity is in PiP right now (for the first render). */
    Function("inPictureInPicture") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity?.isInPictureInPictureMode == true
    }

    /** Open the one Android settings screen that can unblock this feature. */
    Function("openSettings") {
      val context = appContext.reactContext ?: return@Function false
      val packageUri = Uri.parse("package:${context.packageName}")
      val intent =
        Intent(ACTION_PIP_SETTINGS, packageUri).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      try {
        context.startActivity(intent)
      } catch (_: Exception) {
        context.startActivity(
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          },
        )
      }
      true
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
        // Some launchers take their first action snapshot while auto-enter is
        // still resizing the task. Re-apply once the task is pinned so the
        // menu always receives the current mute/end controls as well as the
        // geometry used for the transition.
        if (info.isInPictureInPictureMode && active) {
          try {
            current.setPictureInPictureParams(params(current, autoEnter = false))
          } catch (_: IllegalStateException) {
            // Activity is already being dismissed.
          }
        }
        sendEvent(CHANGE_EVENT, mapOf("inPictureInPicture" to info.isInPictureInPictureMode))
      }
    }
  }

  private fun applyToCurrentActivity() {
    registerActionReceiver()
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

  private fun registerActionReceiver() {
    if (receiverRegistered) return
    val context = appContext.reactContext ?: return
    val filter = IntentFilter().apply {
      addAction(ACTION_TOGGLE_MUTE)
      addAction(ACTION_END_TRIP)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(actionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION") context.registerReceiver(actionReceiver, filter)
    }
    receiverRegistered = true
  }

  private fun action(
    current: Activity,
    intentAction: String,
    requestCode: Int,
    iconRes: Int,
    title: String,
  ): RemoteAction {
    val intent = Intent(intentAction).setPackage(current.packageName)
    val pending =
      PendingIntent.getBroadcast(
        current,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    // These IDs belong to framework-res.apk, not Atlas. Passing the activity
    // context stamps the Icon with Atlas's package name, leaving SystemUI
    // unable to resolve it and causing the whole custom action to disappear.
    return RemoteAction(Icon.createWithResource("android", iconRes), title, title, pending)
  }

  private fun muteAction(current: Activity): RemoteAction =
    action(
      current,
      ACTION_TOGGLE_MUTE,
      REQUEST_TOGGLE_MUTE,
      if (muted) {
        android.R.drawable.ic_lock_silent_mode_off
      } else {
        android.R.drawable.ic_lock_silent_mode
      },
      if (muted) "Unmute guidance" else "Mute guidance",
    )

  private fun endAction(current: Activity): RemoteAction =
    action(
      current,
      ACTION_END_TRIP,
      REQUEST_END_TRIP,
      android.R.drawable.ic_menu_close_clear_cancel,
      "End trip",
    )

  /**
   * A window shaped for a map, flying out of the map viewport it continues to
   * show and falling back to the whole content view before React has measured
   * it. The live map resizes cleanly, so seamless resize avoids a stale cropped
   * snapshot while React commits the compact guidance strip.
   *
   * The shape is the window's whole usefulness. Android sizes PiP from the
   * aspect ratio alone (the shorter edge is a fixed fraction of the screen), so
   * the 16:9 this used to ask for came back as a letterbox — around 160x90 dp,
   * of which the guidance strip took nearly half and the map was left a 160x50
   * dp sliver with no ground ahead of the puck. Asking for 3:4 spends the same
   * budget on height instead: about 110x147 dp, roughly twice the map, and the
   * road ahead is the direction a course-up map needs. The strip stacks itself
   * into two lines at that width (`pipCardMetrics`), which is what keeps the
   * arrival clock rather than running it off the edge.
   */
  private fun params(current: Activity, autoEnter: Boolean): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(PIP_ASPECT_RATIO)
    (sourceRect ?: contentRect(current))?.let { builder.setSourceRectHint(it) }
    if (active) {
      val end = endAction(current)
      builder.setActions(listOf(muteAction(current), end))
      // Android 13 is the first release that lets an app define what the X
      // means. It now invokes the same End trip path as the explicit action,
      // so the window cannot tear down a trip behind React's back.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) builder.setCloseAction(end)
    }
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
    /** Portrait: guidance needs the road ahead more than it needs width. */
    private val PIP_ASPECT_RATIO = Rational(3, 4)
    private const val CHANGE_EVENT = "onPictureInPictureChange"
    private const val ACTION_EVENT = "onPictureInPictureAction"
    private const val ACTION_TOGGLE_MUTE = "io.gjessing.atlas.pip.TOGGLE_MUTE"
    private const val ACTION_END_TRIP = "io.gjessing.atlas.pip.END_TRIP"
    private const val ACTION_PIP_SETTINGS = "android.settings.PICTURE_IN_PICTURE_SETTINGS"
    private const val REQUEST_TOGGLE_MUTE = 4101
    private const val REQUEST_END_TRIP = 4102
  }
}
