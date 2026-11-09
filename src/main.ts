import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { App } from './ui/app';
import { homeScreen } from './ui/screens/home';
import { latencyScreen } from './ui/screens/latency';
import { monitorScreen } from './ui/screens/monitor';
import { resultsScreen } from './ui/screens/results';
import { settingsScreen } from './ui/screens/settings';
import { setupScreen } from './ui/screens/setup';
import { singScreen } from './ui/screens/sing';
import { syncScreen } from './ui/screens/sync';
import { warmupScreen } from './ui/screens/warmup';

const root = document.getElementById('app')!;
const app = new App(root);
app.register('home', homeScreen);
app.register('setup', setupScreen);
app.register('latency', latencyScreen);
app.register('warmup', warmupScreen);
app.register('sing', singScreen);
app.register('results', resultsScreen);
app.register('monitor', monitorScreen);
app.register('settings', settingsScreen);
app.register('sync', syncScreen);
void app.loadPack();
app.go({ name: 'home' });

// Exposed for automated end-to-end checks only.
(window as unknown as { __pitchhero: App }).__pitchhero = app;
