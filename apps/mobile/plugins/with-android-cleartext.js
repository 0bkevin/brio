const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withAndroidCleartext(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return mod;
  });
};
