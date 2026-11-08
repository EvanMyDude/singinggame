import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { App } from './ui/app';
import { homeScreen } from './ui/screens/home';
import { latencyScreen } from './ui/screens/latency';
import { playScreen } from './ui/screens/play';
import { rangeScreen } from './ui/screens/range';
import { resultsScreen } from './ui/screens/results';
import { settingsScreen } from './ui/screens/settings';
import { setupScreen } from './ui/screens/setup';
import { songsScreen } from './ui/screens/songs';
import { trainerScreen } from './ui/screens/trainer';

const root = document.getElementById('app')!;
const app = new App(root);
app.register('home', homeScreen);
app.register('setup', setupScreen);
app.register('range', rangeScreen);
app.register('latency', latencyScreen);
app.register('songs', songsScreen);
app.register('play', playScreen);
app.register('results', resultsScreen);
app.register('trainer', trainerScreen);
app.register('settings', settingsScreen);
app.go({ name: 'home' });

// Exposed for automated end-to-end checks only.
(window as unknown as { __pitchline: App }).__pitchline = app;
