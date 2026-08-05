const { withAndroidManifest, withMainActivity } = require('expo/config-plugins');

const PIP_MAP_LIFECYCLE = `
  // React Native pauses every LifecycleEventListener when the activity enters
  // PiP. MapLibre follows that event by stopping its render loop, so explicitly
  // keep only the map resumed while the floating window is visible. Everything
  // else retains the normal React/activity lifecycle.
  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    if (isInPictureInPictureMode) {
      visitMapViews(findViewById(android.R.id.content), true)
    }
  }

  // A stashed PiP can become genuinely invisible without leaving PiP mode.
  // Pause MapLibre then; onStart resumes it if the user unstashes the window.
  // Expanding to full-screen is intentionally left to React's normal host
  // resume — explicitly pausing on the PiP-exit callback can arrive after that
  // resume and freeze the full-size map instead.
  override fun onStop() {
    if (isInPictureInPictureMode) {
      visitMapViews(findViewById(android.R.id.content), false)
    }
    super.onStop()
  }

  override fun onStart() {
    super.onStart()
    if (isInPictureInPictureMode) {
      visitMapViews(findViewById(android.R.id.content), true)
    }
  }

  private fun visitMapViews(view: View?, resume: Boolean) {
    if (view?.javaClass?.name == "org.maplibre.reactnative.components.mapview.MLRNMapView") {
      // The app sees the RN wrapper but not MapLibre Android's implementation
      // dependency on its compile classpath. Invoke the wrapper's public
      // lifecycle method without adding a second, potentially drifting SDK.
      runCatching {
        view.javaClass.getMethod(if (resume) "onResume" else "onPause").invoke(view)
      }
    }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        visitMapViews(view.getChildAt(index), resume)
      }
    }
  }
`;

// Navigation can shrink into a floating mini window (modules/pip), which the
// activity has to declare — Android ignores enterPictureInPictureMode() without
// it. The activity's configChanges already cover the PiP transitions (Expo's
// template includes screenSize|smallestScreenSize|screenLayout|orientation), so
// the window resize never recreates the activity mid-trip.
module.exports = function withPictureInPicture(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    const activity = application?.activity?.find(
      (item) => item.$['android:name'] === '.MainActivity',
    );
    if (!activity) throw new Error('withPictureInPicture: .MainActivity not found');
    activity.$['android:supportsPictureInPicture'] = 'true';
    return config;
  });
  return withMainActivity(config, (mod) => {
    let source = mod.modResults.contents;
    if (!source.includes('visitMapViews')) {
      const importAnchor = 'import android.os.Bundle\n';
      const classAnchor = 'class MainActivity : ReactActivity() {\n';
      if (!source.includes(importAnchor) || !source.includes(classAnchor)) {
        throw new Error('withPictureInPicture: MainActivity template changed');
      }
      source = source.replace(
        importAnchor,
        `${importAnchor}import android.content.res.Configuration\nimport android.view.View\nimport android.view.ViewGroup\n`,
      );
      source = source.replace(classAnchor, classAnchor + PIP_MAP_LIFECYCLE);
      mod.modResults.contents = source;
    }
    return mod;
  });
};
