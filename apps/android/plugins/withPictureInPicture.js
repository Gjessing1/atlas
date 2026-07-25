const { withAndroidManifest } = require('expo/config-plugins');

// Navigation can shrink into a floating mini window (modules/pip), which the
// activity has to declare — Android ignores enterPictureInPictureMode() without
// it. The activity's configChanges already cover the PiP transitions (Expo's
// template includes screenSize|smallestScreenSize|screenLayout|orientation), so
// the window resize never recreates the activity mid-trip.
module.exports = function withPictureInPicture(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    const activity = application?.activity?.find(
      (item) => item.$['android:name'] === '.MainActivity',
    );
    if (!activity) throw new Error('withPictureInPicture: .MainActivity not found');
    activity.$['android:supportsPictureInPicture'] = 'true';
    return config;
  });
};
