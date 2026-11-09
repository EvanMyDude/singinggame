import { TrackPlayer } from '../../audio/trackPlayer';
import { emptyTiming, fillEnds, snapToOnset, timingComplete, timingFromPhrases, timingMatches, timingToJSON, type LyricTiming } from '../../core/lyrics';
import { fmtTime, vocalOnsets } from '../../core/melody';
import { saveLyricsLocal, saveTimingLocal } from '../../core/songpack';
import type { App, Screen } from '../app';
import { backButton, h, icon, segmented, toggle } from '../dom';

/**
 * Lyric sync: play the reference vocal and tap once per line; taps snap to the nearest
 * detected vocal onset. If the melody extraction found exactly one phrase per line, every
 * line can be pre-filled from the phrases and the job becomes checking. Timing is saved to
 * this browser right away and can be downloaded as timing.json for the project folder.
 */
export function syncScreen(app: App): Screen {
  const pack = app.pack;
  const body = h('div', { class: 'stack' });
  const el = h(
    'div',
    { class: 'screen', style: 'max-width:1000px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'settings' }), 'Settings'), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Sync lyrics'),
    body,
  );
  let destroy: () => void = () => {};

  if (!pack) {
    body.append(h('div', { class: 'notice warn' }, 'Load the song files first (Settings → Song files).'));
    return { el };
  }

  if (!pack.lyrics) {
    const input = h('input', {
      type: 'file',
      accept: '.txt,text/plain',
      style: 'display:none',
      onchange: async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          await saveLyricsLocal(await f.text());
          await app.loadPack(true);
          app.go({ name: 'sync' });
        } catch (e) {
          note.textContent = (e as Error).message;
        }
      },
    });
    const note = h('div', { class: 'notice bad', style: 'display:none' });
    body.append(
      h(
        'div',
        { class: 'card stack' },
        h('p', { style: 'margin:0' }, 'No lyrics are loaded. Provide a plain text file with the song lyrics:'),
        h(
          'ul',
          { class: 'muted small', style: 'margin:0;padding-left:20px' },
          h('li', null, 'one lyric line per line, in the order they are sung (repeat repeated lines)'),
          h('li', null, 'optional section headers in square brackets, e.g. [Chorus]'),
          h('li', null, 'blank lines are ignored'),
        ),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Save it as public/songs/old-town-road/lyrics.txt in the project (it is git-ignored), or pick it here to keep it in this browser.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => input.click() }, 'Choose lyrics.txt'), input),
        note,
      ),
    );
    return { el };
  }

  const doc = pack.lyrics;
  const melody = pack.melody;
  const onsets = vocalOnsets(melody);
  let timing: LyricTiming = pack.timing && timingMatches(pack.timing, doc) ? structuredClone(pack.timing) : emptyTiming(doc);
  let nextLine = timing.lines.findIndex((l) => !Number.isFinite(l.start));
  if (nextLine < 0) nextLine = 0;
  let snap = true;
  let dirty = false;
  const history: LyricTiming[] = [];

  // ---------- player ----------
  const rt = app.rt();
  const player = new TrackPlayer(rt.engine, pack.instrumentalUrl, pack.referenceUrl, { referenceOffset: melody.referenceOffset, onError: (m) => status(m, 'bad') });
  app.activePlayer = player;
  player.setVolume(app.store.settings.musicVol);
  player.setReference(!!pack.referenceUrl);
  let speed = 1;
  player.setRate(speed);
  void player.load().catch((e: Error) => status(`Could not load the song: ${e.message}`, 'bad'));

  const timeEl = h('span', { class: 'time num' }, '0:00');
  const progFill = h('i', { class: 'prog-fill' });
  const marks = h('div', { class: 'prog-marks' });
  const progress = h('div', { class: 'prog seekable', role: 'slider', 'aria-label': 'Position' }, progFill, marks);
  const playBtn = h('button', { class: 'btn primary', onclick: () => void togglePlay() }, icon('play2', 'kbd-icon'), 'Play');
  const tapBtn = h('button', { class: 'btn big tap', onclick: () => tap() }, 'Tap: line starts now', h('span', { class: 'kbd' }, 'Space'));
  const statusEl = h('div', { class: 'notice', style: 'display:none' });
  const status = (text: string, kind: '' | 'good' | 'warn' | 'bad' = '') => {
    statusEl.className = `notice ${kind}`;
    statusEl.textContent = text;
    statusEl.style.display = '';
  };
  const countEl = h('span', { class: 'chip' }, '');
  const list = h('div', { class: 'sync-list' });

  progress.addEventListener('pointerdown', (e) => {
    const r = progress.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * melody.duration);
  });

  const togglePlay = async () => {
    if (player.paused) await player.play();
    else player.pause();
    playBtn.replaceChildren(icon(player.paused ? 'play2' : 'pause', 'kbd-icon'), player.paused ? 'Play' : 'Pause');
  };

  const push = () => {
    history.push(structuredClone(timing));
    if (history.length > 50) history.shift();
    dirty = true;
  };

  const tap = () => {
    if (nextLine >= timing.lines.length) {
      status('Every line is marked. Pick a line in the list to re-mark it.', 'good');
      return;
    }
    push();
    const raw = player.rawTime();
    const t = snap ? snapToOnset(raw, onsets, 0.3) : raw;
    timing.lines[nextLine] = { ...timing.lines[nextLine]!, start: Math.round(t * 1000) / 1000, end: NaN };
    // Keep the order sane: later lines marked earlier than this one are cleared.
    for (let i = nextLine + 1; i < timing.lines.length; i++) {
      if (Number.isFinite(timing.lines[i]!.start) && timing.lines[i]!.start <= t) timing.lines[i] = { start: NaN, end: NaN };
    }
    nextLine++;
    renderList();
  };

  const undo = () => {
    const prev = history.pop();
    if (!prev) return;
    timing = prev;
    nextLine = Math.max(0, timing.lines.findIndex((l) => !Number.isFinite(l.start)));
    if (nextLine < 0) nextLine = timing.lines.length;
    renderList();
  };

  const nudge = (i: number, d: number) => {
    const l = timing.lines[i]!;
    if (!Number.isFinite(l.start)) return;
    push();
    timing.lines[i] = { ...l, start: Math.max(0, Math.round((l.start + d) * 1000) / 1000) };
    renderList();
  };

  const setStart = (i: number, v: number) => {
    if (!Number.isFinite(v)) return;
    push();
    timing.lines[i] = { ...timing.lines[i]!, start: Math.max(0, Math.min(melody.duration, v)) };
    renderList();
  };

  const playFrom = async (i: number) => {
    const l = timing.lines[i]!;
    if (!Number.isFinite(l.start)) return;
    player.seek(Math.max(0, l.start - 1));
    if (player.paused) await togglePlay();
  };

  const prefill = () => {
    const t = timingFromPhrases(doc, melody.phrases);
    if (!t) return;
    push();
    timing = t;
    nextLine = timing.lines.length;
    renderList();
    status(`Pre-filled ${t.lines.length} lines from the detected vocal phrases. Play through and nudge any that are off.`, 'good');
  };

  const save = async () => {
    const filled = fillEnds(timing, melody.duration);
    const json = timingToJSON(filled).replace(/^\{/, `{\n "savedAt": ${JSON.stringify(new Date().toISOString())},`);
    try {
      await saveTimingLocal(json);
      await app.loadPack(true);
      dirty = false;
      status(timingComplete(filled) ? 'Saved. Lyrics will follow the song in Sing and Practice.' : 'Saved (some lines are still unmarked; those will not be shown in time).', 'good');
    } catch (e) {
      status(`Could not save in this browser: ${(e as Error).message}`, 'bad');
    }
    const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'timing.json' });
    document.body.append(a);
    a.click();
    a.remove();
  };

  const renderList = () => {
    const marked = timing.lines.filter((l) => Number.isFinite(l.start)).length;
    countEl.textContent = `${marked} / ${timing.lines.length} lines marked`;
    countEl.className = `chip ${marked === timing.lines.length ? 'ok' : ''}`;
    marks.replaceChildren(...timing.lines.filter((l) => Number.isFinite(l.start)).map((l) => h('i', { style: `left:${(l.start / melody.duration) * 100}%` })));
    list.replaceChildren(
      ...doc.lines.map((line, i) => {
        const l = timing.lines[i]!;
        const has = Number.isFinite(l.start);
        const startInput = h('input', {
          class: 'input num',
          type: 'number',
          step: '0.1',
          min: '0',
          value: has ? l.start.toFixed(2) : '',
          placeholder: '–',
          'aria-label': `Start of line ${i + 1}`,
          onchange: () => setStart(i, Number(startInput.value)),
        });
        const section = doc.sections.find((s) => s.from === i);
        return h(
          'div',
          null,
          section ? h('div', { class: 'panel-title', style: 'margin:14px 0 6px' }, section.name) : null,
          h(
            'div',
            { class: `sync-row ${i === nextLine ? 'next' : ''} ${has ? 'has' : ''}`, onclick: () => { nextLine = i; renderList(); } },
            h('span', { class: 'faint tiny num', style: 'min-width:26px' }, String(i + 1)),
            h('span', { class: 'grow sync-text' }, line.text),
            startInput,
            h('button', { class: 'btn ghost small', onclick: (e: Event) => { e.stopPropagation(); nudge(i, -0.1); }, title: '0.1 s earlier', disabled: !has }, '−'),
            h('button', { class: 'btn ghost small', onclick: (e: Event) => { e.stopPropagation(); nudge(i, 0.1); }, title: '0.1 s later', disabled: !has }, '+'),
            h('button', { class: 'btn ghost small', onclick: (e: Event) => { e.stopPropagation(); void playFrom(i); }, title: 'Play from 1 s before this line', disabled: !has }, icon('play2', 'kbd-icon')),
          ),
        );
      }),
    );
    const row = list.querySelector('.sync-row.next');
    row?.scrollIntoView({ block: 'nearest' });
  };

  const prefillable = melody.phrases.length === doc.lines.length;
  body.append(
    h(
      'div',
      { class: 'card stack' },
      h(
        'div',
        { class: 'row' },
        playBtn,
        segmented([{ value: 0.75, label: '75%' }, { value: 1, label: '100%' }], speed, (v) => { speed = v; player.setRate(v); }, 'Speed'),
        toggle('Snap taps to vocal onsets', snap, (v) => (snap = v)),
        h('div', { class: 'grow' }),
        countEl,
      ),
      h('div', { class: 'transport-row' }, timeEl, progress, h('span', { class: 'time num faint' }, fmtTime(melody.duration))),
      h(
        'div',
        { class: 'row' },
        tapBtn,
        h('button', { class: 'btn', onclick: () => undo() }, 'Undo'),
        prefillable ? h('button', { class: 'btn', onclick: () => prefill(), title: `${melody.phrases.length} vocal phrases detected, one per line` }, 'Pre-fill from vocal phrases') : h('span', { class: 'faint tiny' }, `${melody.phrases.length} vocal phrases detected for ${doc.lines.length} lines: tap each line.`),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary', onclick: () => void save() }, 'Save timing'),
      ),
      statusEl,
      h('p', { class: 'faint tiny', style: 'margin:0' }, 'Press Space (or the Tap button) exactly when the highlighted line begins. Click any line to make it the next one to mark; use − / + to nudge, or type a time. Save writes to this browser and downloads timing.json for public/songs/old-town-road/.'),
    ),
    h('div', { class: 'card' }, list),
  );
  renderList();

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === ' ') {
      e.preventDefault();
      if (player.paused) void togglePlay();
      else tap();
    } else if (e.key === 'Enter' || e.key === 't' || e.key === 'T') tap();
    else if (e.key === 'p' || e.key === 'P') void togglePlay();
    else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      undo();
    }
  };
  window.addEventListener('keydown', onKey);

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const t = player.time;
    timeEl.textContent = fmtTime(t);
    progFill.style.width = `${Math.max(0, Math.min(1, t / (melody.duration || 1))) * 100}%`;
  };
  raf = requestAnimationFrame(loop);

  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);

  destroy = () => {
    cancelAnimationFrame(raf);
    player.destroy();
    if (app.activePlayer === player) app.activePlayer = null;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
  };
  return { el, destroy: () => destroy() };
}
