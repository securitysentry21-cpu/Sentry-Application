// Entry point. The background location task must be defined before anything else runs, at module
// top level, so it exists when Android starts the app headless (no screen) to deliver locations.
import './src/platform/location-task.ts';

import { registerRootComponent } from 'expo';

import { installCrashHandler } from './src/platform/crash-handler.ts';
import App from './src/ui/App.tsx';

// Errors nobody handled go to our own server, without their message (ARCH §18.6).
installCrashHandler();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App) and sets up the
// environment for a native (development or release) build.
registerRootComponent(App);
