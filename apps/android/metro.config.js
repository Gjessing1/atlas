// Metro config for the Android app.
//
// The only job here is keeping the file watcher off native build output. In a
// workspace this size Metro crawls the repo root, and `apps/android/android/`
// plus the Gradle home cache contain tens of thousands of directories — enough
// to exhaust the system inotify watch limit and kill the dev server with
// `ENOSPC` before it ever serves a bundle (see CLAUDE.md "Key Gotchas"; the
// same limit is shared with every other watcher running on this machine).
//
// These paths are all generated and gitignored, so nothing here is a source of
// truth Metro needs to see change.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const IGNORED = [
  /\/apps\/android\/android\/.*/,
  /\/apps\/android\/\.gradle-home\/.*/,
  /\/apps\/android\/\.expo\/.*/,
  /\/\.cxx\/.*/,
  // Native sources shipped inside npm packages. Two thirds of the directories
  // under node_modules are these, and Metro never bundles from them — it
  // resolves JS through each package's entry points. Excluding them is what
  // brings the watch count within reach of a shared inotify budget.
  /\/node_modules\/.*\/android\/.*/,
  /\/node_modules\/.*\/ios\/.*/,
  /\/node_modules\/.*\/windows\/.*/,
];

// metro-file-map takes the resolver blockList as its crawl/watch ignore
// pattern, so excluding here keeps the paths out of the watcher too.
config.resolver.blockList = IGNORED;

module.exports = config;
