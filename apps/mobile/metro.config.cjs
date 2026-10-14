const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === 'crypto' && context.originModulePath.includes('salty-crypto')) {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/platform/node-random.ts') };
  }
  return resolve ? resolve(context, name, platform) : context.resolveRequest(context, name, platform);
};
module.exports = config;
