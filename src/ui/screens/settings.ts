import { listMics } from '../../audio/mic';
import type { Settings } from '../../core/storage';
import type { App, Screen } from '../app';
import { packFilesCard } from '../components/packFiles';
import { backButton, h, icon, slider, toggle } from '../dom';
import { gateFromSensitivity, sensitivityFromGate } from './setup';

export function settingsScreen(app: App): Screen {
  const s = () => app.store.settings;
  const set = (patch: Partial<Settings>) => {
    app.store.updateSettings(patch);
    app.applyAudioSettings();
  };

  const row = (title: string, desc: string | null, control: HTMLElement | HTMLElement[]) =>
    h(
      'div',
      { class: 'setting-row' },
      h('div', null, h('div', null, title), desc ? h('div', { class: 'desc' }, desc) : null),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, ...(Array.isArray(control) ? control : [control])),
    );

  const volume = (key: 'musicVol' | 'monitorVol', label: string) => {
    const val = h('span', { class: 'val' }, `${Math.round(s()[key] * 100)}%`);
    return [
      slider({
        min: 0,
        max: 1,
        step: 0.01,
        value: s()[key],
        ariaLabel: label,
        onInput: (v) => {
          val.textContent = `${Math.round(v * 100)}%`;
          set({ [key]: v } as Partial<Settings>);
        },
      }),
      val,
    ];
  };

  const deviceSelect = h('select', {
    'aria-label': 'Microphone',
    onchange: async () => {
      set({ deviceId: deviceSelect.value });
      if (app.micReady) {
        const err = await app.openMic(deviceSelect.value);
        micMsg.textContent = err ?? '';
      }
    },
  });
  const micMsg = h('div', { class: 'desc', style: 'color:var(--off)' });
  void listMics().then((ds) => {
    const labeled = ds.filter((d) => d.label);
    if (!labeled.length) {
      deviceSelect.append(h('option', null, app.micReady ? 'Default microphone' : 'Allow the mic to choose a device'));
      deviceSelect.disabled = !app.micReady;
      return;
    }
    const cur = app.micReady ? app.rt().mic.deviceId : s().deviceId;
    deviceSelect.append(...labeled.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label)));
  });

  const sensVal = h('span', { class: 'val' }, String(sensitivityFromGate(s().gateDb)));
  const monitorToggle = toggle('', s().monitoring, (v) => set({ monitoring: v }));
  const monitorInput = monitorToggle.querySelector('input')!;
  const syncMonitor = () => {
    monitorInput.disabled = !s().headphones;
    if (!s().headphones) monitorInput.checked = false;
  };
  syncMonitor();

  const latVal = h('span', { class: 'val' }, s().latencyMs === null ? 'auto' : `${s().latencyMs} ms`);
  const latSlider = slider({
    min: 0,
    max: 400,
    step: 5,
    value: s().latencyMs ?? Math.round(app.latency() * 1000),
    ariaLabel: 'Latency offset',
    onInput: (v) => {
      latVal.textContent = `${v} ms`;
      set({ latencyMs: v });
    },
  });

  const lyricStatus = h('div', { class: 'desc' });
  const renderLyricStatus = () => {
    const p = app.pack;
    lyricStatus.textContent = !p ? 'Load the song files first.' : !p.lyrics ? 'No lyrics loaded: add lyrics.txt above or in the sync tool.' : !p.timing ? `${p.lyrics.lines.length} lines loaded, not synced yet.` : `${p.lyrics.lines.length} lines, synced (${p.sources.timing === 'static' ? 'timing.json in project' : 'saved in this browser'}).`;
  };
  renderLyricStatus();

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('h2', { style: 'font-size:22px' }, 'Settings'), h('div', { class: 'spacer' })),
    h(
      'div',
      { class: 'settings-grid' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'panel-title' }, 'Microphone'),
        row('Input device', null, deviceSelect),
        micMsg,
        row('Sensitivity', 'Higher hears quieter singing; lower ignores more room noise.', [
          slider({
            min: 0,
            max: 100,
            step: 1,
            value: sensitivityFromGate(s().gateDb),
            ariaLabel: 'Microphone sensitivity',
            onInput: (v) => {
              sensVal.textContent = String(v);
              set({ gateDb: gateFromSensitivity(v) });
            },
          }),
          sensVal,
        ]),
        row(
          'Headphones',
          'On: best accuracy, mic monitoring allowed. Off: echo cancellation is used so the speakers are not mistaken for your voice.',
          toggle('', s().headphones, async (v) => {
            set({ headphones: v, monitoring: v ? s().monitoring : false });
            syncMonitor();
            if (app.micReady) await app.openMic();
          }),
        ),
        row('Microphone monitoring', 'Hear yourself in your headphones. Only with headphones, to avoid feedback.', monitorToggle),
        row('Monitor volume', null, volume('monitorVol', 'Monitor volume')),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => app.go({ name: 'setup', next: { name: 'settings' } }) }, 'Open mic check')),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'panel-title' }, 'Music and timing'),
        row('Music volume', 'Instrumental and reference track.', volume('musicVol', 'Music volume')),
        row('Latency offset', 'Round-trip audio delay removed before scoring.', [latSlider, latVal]),
        h(
          'div',
          { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn', onclick: () => app.go({ name: 'latency', next: { name: 'settings' } }) }, 'Calibrate latency'),
          h('button', { class: 'btn ghost', onclick: () => { set({ latencyMs: null }); latVal.textContent = 'auto'; } }, 'Use automatic'),
        ),
        h('div', { class: 'divider', style: 'margin:14px 0' }),
        h('div', { class: 'panel-title' }, 'Scoring and display'),
        row('Octave forgiveness', 'Singing the right note in another octave counts as correct.', toggle('', s().foldOctaves, (v) => set({ foldOctaves: v }))),
        row('Show note names', 'Label the pitch lanes while singing.', toggle('', s().showNoteNames, (v) => set({ showNoteNames: v }))),
      ),
      packFilesCard(app, renderLyricStatus),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'panel-title' }, 'Lyrics'),
        row('Lyric timing', null, h('button', { class: 'btn', onclick: () => app.go({ name: 'sync' }) }, icon('lyrics', 'kbd-icon'), 'Sync lyrics')),
        lyricStatus,
        h('div', { class: 'divider', style: 'margin:14px 0' }),
        h('div', { class: 'panel-title' }, 'Data'),
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Settings, latency, scores and song files are stored only in this browser. Nothing is sent anywhere.'),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: () => {
              if (confirm('Erase settings, latency and scores from this browser? (Song files stay; remove them above.)')) {
                app.store.resetAll();
                app.go({ name: 'home' });
              }
            },
          },
          'Reset settings and scores',
        ),
      ),
    ),
  );
  return { el };
}
