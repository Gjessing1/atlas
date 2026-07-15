import { registerRootComponent } from 'expo';

// Registers the background-location TaskManager task in the global scope, before
// the foreground service can fire it on a cold start.
import './src/nav/locationTask';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
