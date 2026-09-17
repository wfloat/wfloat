const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// The SDK is a local file dependency. Resolve its React imports from this app
// so the linked checkout cannot introduce a second React or RN instance.
const sdk = path.resolve(__dirname, "../../packages/react-native-wfloat");
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [sdk],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.resolve(__dirname, "node_modules")],
  },
});
