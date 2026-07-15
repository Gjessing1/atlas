// Expo config plugin: release signing from env vars.
//
// The generated android/ directory is gitignored (CNG), so the release
// signingConfig must be injected at prebuild time rather than edited by hand.
// Signing credentials come from the environment (see build-apk.sh, which loads
// ~/.config/atlas/keystore.env); when they are absent the release build falls
// back to the debug keystore so `expo run:android` keeps working untouched.
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING_CONFIG = `        release {
            if (System.getenv("ATLAS_KEYSTORE_FILE")) {
                storeFile file(System.getenv("ATLAS_KEYSTORE_FILE"))
                storePassword System.getenv("ATLAS_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ATLAS_KEY_ALIAS")
                keyPassword System.getenv("ATLAS_KEY_PASSWORD")
            }
        }
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (!gradle.includes('ATLAS_KEYSTORE_FILE')) {
      const releaseTypeSigning =
        '            signingConfig signingConfigs.debug\n' +
        '            def enableShrinkResources';
      if (!gradle.includes(releaseTypeSigning) || !gradle.includes('signingConfigs {\n')) {
        throw new Error(
          'withReleaseSigning: app/build.gradle template changed; update the plugin anchors',
        );
      }
      gradle = gradle.replace(
        releaseTypeSigning,
        '            signingConfig System.getenv("ATLAS_KEYSTORE_FILE") ' +
          '? signingConfigs.release : signingConfigs.debug\n' +
          '            def enableShrinkResources',
      );
      gradle = gradle.replace('signingConfigs {\n', 'signingConfigs {\n' + RELEASE_SIGNING_CONFIG);
      mod.modResults.contents = gradle;
    }
    return mod;
  });
};
