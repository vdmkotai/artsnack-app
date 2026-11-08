// Learn more: https://docs.expo.dev/guides/monorepo/
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const { wrapWithReanimatedMetroConfig } = require("react-native-reanimated/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// packages/shared is plain TypeScript imported by relative path, so Metro has to
// watch outside this app's directory or edits there never trigger a reload.
config.watchFolders = [workspaceRoot];

// Project first, workspace second. Bun hoists what it can, but anything this app
// pins differently from apps/web lands in apps/native/node_modules and must win.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Hierarchical lookup stays ON because Bun installs isolated: a package's own
// dependencies live in node_modules/.bun/<pkg>/node_modules, and finding them
// requires walking up. However, apps/web and apps/native intentionally use
// different React patch versions. Some packages have peer-dependency links for
// both workspaces, so an unrestricted hierarchical lookup can put both React
// copies in the native bundle and make React Native abort at startup.
//
// Always resolve React and React Native (including internal subpath imports)
// from the native app. Other packages keep Bun's normal hierarchical
// resolution.
const nativeSingletonPackages = ["react", "react-dom", "react-native"];
const nativeSingletonEntries = new Map();

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singletonPackage = nativeSingletonPackages.find(
    (packageName) => moduleName === packageName || moduleName.startsWith(`${packageName}/`),
  );

  if (singletonPackage && !nativeSingletonEntries.has(moduleName)) {
    nativeSingletonEntries.set(moduleName, require.resolve(moduleName, { paths: [projectRoot] }));
  }

  return context.resolveRequest(
    context,
    nativeSingletonEntries.get(moduleName) ?? moduleName,
    platform,
  );
};

// Uniwind compiles global.css into the style objects HeroUI Native's components
// read, and writes the theme-name union into uniwind-env.d.ts. It has to be the
// outermost wrapper so it sees the finished resolver above.
module.exports = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-env.d.ts",
});
