const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidKeyboard(config) {
  return withAndroidManifest(config, (mod) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    activity.$ = activity.$ || {};
    // React Native owns the IME inset so the composer and transcript can move
    // together instead of Android panning only the focused text field.
    activity.$['android:windowSoftInputMode'] = 'adjustNothing';
    return mod;
  });
};
