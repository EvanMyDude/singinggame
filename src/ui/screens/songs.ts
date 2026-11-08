import { keyName } from '../../core/music';
import type { Song } from '../../core/song';
import type { AttemptRecord } from '../../core/storage';
import type { App, PlayConfig, Route, Screen } from '../app';
import { backButton, fmtInt, h, segmented, toggle } from '../dom';
import { importMidiFile } from './importMidi';

type MixMode = 'both' | 'guide' | 'backing';

export function songsScreen(app: App, route: Route): Screen {
  let selected = (route.name === 'songs' && route.selectId && app.songById(route.selectId)) || app.songs()[0]!;
  let mode: 'sing' | 'practice' = 'sing';
  let section = 0;
  let speed = 0.75;
  let loop = true;
  let mix: MixMode = 'both';

  const list = h('div', { class: 'song-list', role: 'listbox', 'aria-label': 'Songs' });
  const detail = h('div', { class: 'stack' });
  const importMsg = h('div');

  const fileInput = h('input', {
    type: 'file',
    accept: '.mid,.midi,.kar,audio/midi',
    style: 'display:none',
    onchange: async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const res = await importMidiFile(f);
      if ('error' in res) {
        importMsg.replaceChildren(h('div', { class: 'notice bad', style: 'margin-top:8px' }, res.error));
        return;
      }
      if (!app.addImported(res.song)) {
        importMsg.replaceChildren(h('div', { class: 'notice bad', style: 'margin-top:8px' }, 'Could not save the imported song (browser storage is full or blocked).'));
        return;
      }
      importMsg.replaceChildren(h('div', { class: 'notice good', style: 'margin-top:8px' }, `Imported "${res.song.title}" (${res.song.notes.length} notes${res.note ? `; ${res.note}` : ''}).`));
      selected = res.song;
      renderList();
      renderDetail();
    },
  });

  const renderList = () => {
    list.replaceChildren(
      ...app.songs().map((s) => {
        const p = app.store.progress(s.id);
        const t = app.transposeFor(s);
        return h(
          'button',
          {
            class: 'song-card',
            role: 'option',
            'aria-selected': String(s.id === selected.id),
            onclick: () => {
              selected = s;
              section = 0;
              renderList();
              renderDetail();
            },
          },
          h('div', { class: 'title' }, s.title),
          h(
            'div',
            { class: 'meta row', style: 'gap:8px' },
            pips(s.difficulty),
            h('span', null, s.imported ? 'Imported MIDI' : s.credit),
            t.semitones !== 0 ? h('span', { class: 'chip accent', style: 'padding:1px 7px' }, `${t.semitones > 0 ? '+' : ''}${t.semitones}`) : null,
          ),
          h('div', { class: 'best' }, p.best ? h('span', { class: `grade-badge grade-${p.best.grade}` }, p.best.grade) : h('span', { class: 'faint tiny' }, 'New')),
        );
      }),
    );
  };

  const renderDetail = () => {
    const s = selected;
    const p = app.store.progress(s.id);
    const t = app.transposeFor(s);
    const yours = keyName(s.tonicPc + t.semitones, s.mode);
    const original = keyName(s.tonicPc, s.mode);
    const range = app.store.data.range;
    const secs = Math.round((s.totalBeats * 60) / s.bpm);
    if (section >= s.sections.length) section = 0;

    const setTranspose = (v: number | null) => {
      app.store.setTransposeOverride(s.id, v);
      renderList();
      renderDetail();
    };

    const keyBlock = h(
      'div',
      { class: 'stack', style: 'gap:8px' },
      h(
        'div',
        { class: 'key-compare' },
        h('div', { class: 'k' }, h('span', { class: 'hud-label' }, 'Original key'), h('b', null, original)),
        h('div', { class: 'arrow' }, '→'),
        h(
          'div',
          { class: 'k yours' },
          h('span', { class: 'hud-label' }, t.override ? 'Your key (manual)' : range ? 'Comfortable key for you' : 'Your key'),
          h('b', null, yours),
          h('span', { class: 'faint tiny' }, t.semitones === 0 ? 'Same as written' : `${t.semitones > 0 ? 'Up' : 'Down'} ${Math.abs(t.semitones)} semitone${Math.abs(t.semitones) === 1 ? '' : 's'}`),
        ),
      ),
      h(
        'div',
        { class: 'row small' },
        h('button', { class: 'btn', style: 'padding:6px 12px', onclick: () => setTranspose(t.semitones - 1), 'aria-label': 'Lower key' }, '−'),
        h('button', { class: 'btn', style: 'padding:6px 12px', onclick: () => setTranspose(t.semitones + 1), 'aria-label': 'Raise key' }, '+'),
        t.override ? h('button', { class: 'btn ghost', onclick: () => setTranspose(null) }, range ? 'Auto-fit to my range' : 'Reset') : null,
        t.semitones !== 0 ? h('button', { class: 'btn ghost', onclick: () => setTranspose(0) }, 'Use original key') : null,
        !range ? h('button', { class: 'btn ghost', onclick: () => app.go({ name: 'range', next: { name: 'songs', selectId: s.id } }) }, 'Fit to my voice…') : null,
      ),
    );

    const practiceOpts =
      mode === 'practice'
        ? h(
            'div',
            { class: 'stack', style: 'gap:12px' },
            h(
              'div',
              { class: 'field' },
              h('label', null, 'Section'),
              h(
                'select',
                { onchange: (e: Event) => (section = Number((e.target as HTMLSelectElement).value)), 'aria-label': 'Section' },
                ...s.sections.map((sec, i) => h('option', { value: String(i), selected: i === section }, `${sec.name}${lyricPreview(s, i)}`)),
              ),
            ),
            h('div', { class: 'row' }, h('span', { class: 'field-label', style: 'min-width:60px' }, 'Speed'), segmented([{ value: 1, label: '100%' }, { value: 0.75, label: '75%' }, { value: 0.5, label: '50%' }], speed, (v) => (speed = v), 'Speed')),
            h(
              'div',
              { class: 'row' },
              h('span', { class: 'field-label', style: 'min-width:60px' }, 'Hear'),
              segmented(
                [
                  { value: 'both' as MixMode, label: 'Band + melody' },
                  { value: 'guide' as MixMode, label: 'Melody only' },
                  { value: 'backing' as MixMode, label: 'Band only' },
                ],
                mix,
                (v) => (mix = v),
                'Audio mix',
              ),
            ),
            toggle('Loop this section', loop, (v) => (loop = v)),
          )
        : null;

    const start = () => {
      const config: PlayConfig = {
        songId: s.id,
        mode,
        speed: mode === 'practice' ? speed : 1,
        section: mode === 'practice' ? section : null,
        loop: mode === 'practice' ? loop : false,
        guide: mode === 'practice' ? mix !== 'backing' : true,
        backing: mode === 'practice' ? mix !== 'guide' : true,
        transpose: t.semitones,
      };
      void app.startSong(config);
    };

    detail.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          null,
          h('h2', { style: 'font-size:28px' }, s.title),
          h('div', { class: 'muted small', style: 'margin-top:4px' }, `${s.credit} · ${s.bpm} BPM · ${s.beatsPerBar}/4 · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${s.notes.length} notes`),
          h('div', { class: 'faint tiny', style: 'margin-top:4px' }, s.pdNote),
        ),
        keyBlock,
        h('div', { class: 'row' }, segmented([{ value: 'sing' as const, label: 'Sing the Song' }, { value: 'practice' as const, label: 'Practice Section' }], mode, (v) => { mode = v; renderDetail(); }, 'Mode')),
        practiceOpts,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn primary big', onclick: start }, mode === 'sing' ? 'Start' : 'Start practice'),
          h('div', { class: 'grow' }),
          s.imported ? h('button', { class: 'btn ghost danger', onclick: () => { app.removeImported(s.id); selected = app.songs()[0]!; renderList(); renderDetail(); } }, 'Remove') : null,
        ),
      ),
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'panel-title' }, 'Your progress'),
        p.best
          ? h(
              'div',
              { class: 'row', style: 'gap:18px' },
              h('span', { class: `grade-badge grade-${p.best.grade}`, style: 'width:48px;height:48px;font-size:26px' }, p.best.grade),
              h('div', null, h('div', { class: 'hud-label' }, 'High score'), h('div', { class: 'num', style: 'font-size:28px;font-weight:650' }, fmtInt(p.best.score))),
              h('div', null, h('div', { class: 'hud-label' }, 'Accuracy'), h('div', { class: 'num', style: 'font-size:28px;font-weight:650' }, `${Math.round(p.best.accuracy)}%`)),
              h('div', null, h('div', { class: 'hud-label' }, 'Plays'), h('div', { class: 'num', style: 'font-size:28px;font-weight:650' }, String(p.plays))),
            )
          : h('div', { class: 'muted small' }, 'No full-speed runs yet. Your high score and accuracy trend will show here.'),
        p.attempts.filter((a) => a.mode === 'sing' && a.speed === 1).length >= 2 ? sparkline(p.attempts.filter((a) => a.mode === 'sing' && a.speed === 1)) : null,
      ),
    );
  };

  renderList();
  renderDetail();

  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'topbar' },
      backButton(() => app.go({ name: 'home' })),
      h('h2', { style: 'font-size:22px' }, 'Songs'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => fileInput.click() }, 'Import MIDI…'),
      fileInput,
    ),
    importMsg,
    h('div', { class: 'songs-layout', style: 'margin-top:8px' }, list, detail),
  );
  return { el };
}

function pips(n: number): HTMLElement {
  return h('span', { class: 'pips', title: ['Easy', 'Medium', 'Harder'][n - 1] }, ...[1, 2, 3].map((i) => h('i', { class: i <= n ? 'on' : '' })));
}

function lyricPreview(s: Song, i: number): string {
  const sec = s.sections[i]!;
  const words = s.notes
    .slice(sec.noteFrom, sec.noteTo)
    .map((n) => n.lyric)
    .filter(Boolean)
    .join(' ')
    .replace(/- /g, '');
  if (!words) return '';
  const short = words.split(' ').slice(0, 5).join(' ');
  return `: "${short}${words.length > short.length ? '…' : ''}"`;
}

/** Accuracy trend of recent attempts. */
export function sparkline(attempts: AttemptRecord[]): HTMLElement {
  const pts = attempts.slice(-15);
  const w = 300;
  const hh = 46;
  const xs = (i: number) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 8) + 4);
  const ys = (a: number) => hh - 4 - (Math.max(0, Math.min(100, a)) / 100) * (hh - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.accuracy).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const wrap = h('div', null, h('div', { class: 'hud-label', style: 'margin-bottom:4px' }, `Accuracy, last ${pts.length} full runs`));
  wrap.insertAdjacentHTML(
    'beforeend',
    `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" role="img" aria-label="Accuracy trend"><path d="${d}" fill="none" stroke="#5ee0ff" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`,
  );
  wrap.append(h('div', { class: 'faint tiny' }, `Latest ${Math.round(last.accuracy)}% · best ${Math.round(Math.max(...pts.map((p) => p.accuracy)))}%`));
  return wrap;
}
