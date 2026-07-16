const { withGradleProperties } = require('expo/config-plugins');

// libvalhalla is prebuilt for 64-bit ABIs only (modules/valhalla), so build
// the app for exactly that set — otherwise a 32-bit device would install a
// variant whose routing engine is missing and crash on first use.
const ABIS = 'arm64-v8a,x86_64';

module.exports = function withAndroidAbis(config) {
  return withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'reactNativeArchitectures'),
    );
    config.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: ABIS });
    return config;
  });
};
