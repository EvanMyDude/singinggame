import { decodeMono, runAnalysis, sourceSignature, type AnalysisRun } from '../../analysis/client';
import type { AnalysisReport, MelodyDoc } from '../../analysis/prepare';
import { localSongDoc, localSource, saveLocalMelody, saveLocalSong, type LocalSongDoc } from '../../core/localSongs';
import { parseLyrics } from '../../core/lyrics';
import { noteNameWithOctave } from '../../core/music';
import { audioRole, forgetPack, titleFromFileName } from '../../core/songpack';
import { songIdFor } from '../../core/songs';
import type { App, Route, Screen } from '../app';
import { fileDropZone, fileSlotRow, missingChip } from '../components/fileSlots';
import { backButton, h, icon } from '../dom';

/**
 * Add a song from its stems: the instrumental, the isolated lead vocal and, optionally, the
 * full mix, plus the lyrics. The browser makes the pitch targets (src/analysis/, a port of
 * tools/prepare_song.py) and stores everything in IndexedDB; nothing is uploaded. With
 * `songId`, the stored stems of a song added earlier are analyzed again.
 */

type Slot = 'instrumental' | 'vocal' | 'mix';

const SLOTS: { key: Slot; label: string; hint: string; required: boolean }[] = [
  { key: 'instrumental', label: 'Instrumental (karaoke) track', hint: 'the track you sing over', required: true },
  { key: 'vocal', label: 'Isolated lead vocal', hint: 'the vocal alone; the targets are made from it', required: true },
  { key: 'mix', label: 'Full mix (optional)', hint: 'the original song; lines the files up and plays with Reference vocal on', required: false },
];

const AUDIO = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;

function fmtSize(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} kB`;
}

export function addSongScreen(app: App, route: Route): Screen {
  const songId = route.name === 'addSong' ? route.songId : undefined;
  const existing = songId ? app.songs.find((s) => s.id === songId && s.origin === 'local') ?? null : null;
  const files: Record<Slot, Blob | null> = { instrumental: null, vocal: null, mix: null };
  const names: Record<Slot, string> = { instrumental: '', vocal: '', mix: '' };
  let run: AnalysisRun | null = null;
  let result: { doc: MelodyDoc; report: AnalysisReport } | null = null;
  let destroyed = false;
  /** True from Make targets until the report (or an error): the files must not change meanwhile. */
  let working = false;

  const titleIn = h('input', { class: 'input', type: 'text', placeholder: 'Song title', 'aria-label': 'Song title', maxlength: 120 });
  const artistIn = h('input', { class: 'input', type: 'text', placeholder: 'Artist (optional)', 'aria-label': 'Artist', maxlength: 120 });
  const lyricsIn = h('textarea', {
    class: 'input lyrics-input',
    rows: 8,
    placeholder: 'Paste the lyrics: one sung line per line, in order, repeated lines repeated. [Chorus]-style headers are fine. You can also add them later.',
    'aria-label': 'Lyrics',
  });
  const gateIn = h('input', { class: 'input', type: 'number', min: 10, max: 60, step: 1, value: 35, 'aria-label': 'Level gate in dB', style: 'width:90px' });
  const msg = h('div', { class: 'notice', style: 'display:none' });
  const slotsHost = h('div', { class: 'stack', style: 'gap:0' });
  const progressFill = h('i', { class: 'prog-fill' });
  // flex:none: .prog fills a transport row's width; in this column it must keep its height.
  const progressBar = h('div', { class: 'prog', style: 'flex:none', role: 'progressbar', 'aria-label': 'Analysis progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progressFill);
  const progressText = h('div', { class: 'muted small' });
  const progress = h('div', { class: 'stack', style: 'display:none;gap:8px' }, progressBar, progressText);
  const reportHost = h('div');
  const analyzeBtn = h('button', { class: 'btn primary big', onclick: () => void analyze() }, existing ? 'Analyze again' : 'Make targets');
  const cancelBtn = h('button', { class: 'btn ghost', style: 'display:none', onclick: () => run?.cancel() }, 'Cancel');

  const say = (kind: '' | 'good' | 'warn' | 'bad', text: string) => {
    msg.className = `notice ${kind}`;
    msg.textContent = text;
    msg.style.display = text ? '' : 'none';
  };

  const busy = (on: boolean) => {
    working = on;
    for (const el of [titleIn, artistIn, lyricsIn, gateIn, analyzeBtn]) el.disabled = on;
    slotsHost.querySelectorAll('button').forEach((b) => (b.disabled = on || !!existing));
    cancelBtn.style.display = on ? '' : 'none';
    progress.style.display = on ? '' : 'none';
  };

  /** Any change of input makes a shown report stale: drop it and make analysis the next step again. */
  const clearResult = () => {
    result = null;
    reportHost.replaceChildren();
    analyzeBtn.className = 'btn primary big';
  };

  const setFile = (slot: Slot, f: File) => {
    if (!(f.type.startsWith('audio/') || AUDIO.test(f.name))) {
      say('bad', `${f.name} is not an audio file.`);
      return;
    }
    files[slot] = f;
    names[slot] = f.name;
    if (!titleIn.value.trim()) titleIn.value = titleFromFileName(f.name);
    clearResult();
    renderSlots();
  };

  const renderSlots = () => {
    slotsHost.replaceChildren(
      ...SLOTS.map((s) => {
        const f = files[s.key];
        return fileSlotRow({
          label: s.label,
          desc: s.hint,
          state: f ? h('span', { class: 'chip ok' }, h('i', { class: 'dot' }), `${names[s.key]} · ${fmtSize(f.size)}`) : missingChip(s.required),
          // Analyzing again uses the stored files: nothing to pick.
          accept: existing ? null : 'audio/*,.mp3,.m4a,.wav,.ogg,.aac,.flac',
          filled: !!f,
          onPick: (file) => setFile(s.key, file),
          ...(existing || !f || s.required
            ? {}
            : {
                onRemove: () => {
                  files[s.key] = null;
                  names[s.key] = '';
                  clearResult();
                  renderSlots();
                },
              }),
        });
      }),
    );
  };

  const handleDrop = async (list: FileList | File[]) => {
    if (working) return say('warn', 'Wait for the analysis to finish, or cancel it, before changing the files.');
    const unknown: string[] = [];
    for (const f of [...list]) {
      if (/\.(txt|lrc)$/i.test(f.name) || f.type === 'text/plain') {
        lyricsIn.value = await f.text();
        continue;
      }
      const role = audioRole(f.name);
      if (role === 'instrumental') setFile('instrumental', f);
      else if (role === 'vocal') setFile('vocal', f);
      else if (role === 'mix') setFile('mix', f);
      else unknown.push(f.name);
    }
    say(unknown.length ? 'warn' : '', unknown.length ? `Could not tell what ${unknown.join(', ')} is from its name. Use the Choose button next to the right slot.` : '');
  };

  const drop = fileDropZone({
    hint: 'Sorted by name: "instrumental" or "karaoke", "vocals only" or "acapella", "full" or "with vocals"; a .txt file fills the lyrics.',
    onFiles: (list) => void handleDrop(list),
  });

  const renderReport = () => {
    if (!result) return;
    // One primary call to action at a time: saving is now the next step.
    analyzeBtn.className = 'btn big';
    const { report } = result;
    const range = report.range ? `${noteNameWithOctave(report.range[0])}–${noteNameWithOctave(report.range[1])}` : '';
    reportHost.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'panel-title', style: 'margin:0' }, 'Targets'),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:wrap' },
          h('span', { class: `chip ${report.noteCount ? 'ok' : 'warn'}` }, h('i', { class: 'dot' }), `${report.noteCount} notes`),
          h('span', { class: 'chip' }, `${report.scoredSeconds.toFixed(1)} s of targets`),
          h('span', { class: 'chip' }, `${report.presentSeconds.toFixed(1)} s of detected vocal`),
          range ? h('span', { class: 'chip' }, `range ${range}`) : null,
        ),
        ...report.warnings.map((w) => h('div', { class: 'notice warn' }, w)),
        h('ul', { class: 'muted small report-lines' }, ...report.lines.map((l) => h('li', null, l))),
        h('p', { class: 'faint tiny', style: 'margin:0' }, 'Seconds left without a target are tracker measurements, not verified statements about the singing. Passages without targets still show the lyrics and your pitch; they are not scored.'),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:wrap' },
          h('button', { class: 'btn primary big', onclick: () => void save(false) }, existing ? 'Use the new targets' : 'Save song'),
          !existing && lyricsIn.value.trim() ? h('button', { class: 'btn', onclick: () => void save(true) }, 'Save and sync lyrics') : null,
        ),
      ),
    );
  };

  const analyze = async () => {
    say('', '');
    if (!existing && !titleIn.value.trim()) return say('bad', 'Give the song a title.');
    if (!files.instrumental || !files.vocal) return say('bad', 'The instrumental and the isolated vocal are both needed.');
    const gate = Number(gateIn.value);
    if (!(gate >= 10 && gate <= 60)) return say('bad', 'The level gate must be between 10 and 60 dB.');
    clearResult();
    busy(true);
    const setProgress = (stage: string, f: number) => {
      progressFill.style.width = `${Math.round(f * 100)}%`;
      progressBar.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      progressText.textContent = `${stage}…`;
    };
    try {
      setProgress('Decoding the instrumental', 0);
      const instrumental = await decodeMono(files.instrumental);
      setProgress('Decoding the vocal', 0);
      const vocal = await decodeMono(files.vocal);
      let mix: Float32Array | null = null;
      if (files.mix) {
        setProgress('Decoding the full mix', 0);
        mix = await decodeMono(files.mix);
      }
      const signature = sourceSignature([files.instrumental, files.vocal, files.mix]).catch(() => null);
      if (destroyed) return;
      run = runAnalysis({ instrumental, vocal, mix, referenceKind: files.mix ? 'mix' : 'vocal', gateDb: gate }, setProgress);
      const r = await run.promise;
      const sig = await signature;
      if (sig) r.doc.sources = sig;
      result = r;
      renderReport();
    } catch (e) {
      if (!destroyed) say((e as Error).message === 'Cancelled.' ? '' : 'bad', (e as Error).message === 'Cancelled.' ? '' : `Could not analyze the song: ${(e as Error).message}`);
    } finally {
      run = null;
      if (!destroyed) busy(false);
    }
  };

  const save = async (thenSync: boolean) => {
    if (!result || !files.instrumental || !files.vocal) return;
    const melodyJson = JSON.stringify(result.doc);
    try {
      if (existing) {
        await saveLocalMelody(existing.id, melodyJson);
        forgetPack(existing.id);
        await app.reloadRegistry();
        app.selectSong(existing.id);
        await app.loadPack(true);
        app.go({ name: 'settings' });
        return;
      }
      const lyricsText = lyricsIn.value.trim() ? lyricsIn.value : null;
      if (lyricsText !== null && !parseLyrics(lyricsText).lines.length) return say('bad', 'The lyrics have no lyric lines. Remove them or add the sung lines.');
      const id = songIdFor(titleIn.value.trim(), app.songs.map((s) => s.id));
      const doc: LocalSongDoc = {
        version: 1,
        id,
        title: titleIn.value.trim(),
        artist: artistIn.value.trim(),
        files: {
          instrumental: names.instrumental || 'instrumental.mp3',
          ...(files.mix ? { reference: names.mix } : { reference: names.vocal }),
          vocal: names.vocal || 'vocal.mp3',
          lyrics: 'lyrics.txt',
          timing: 'timing.json',
          melody: 'melody.json',
        },
        referenceKind: files.mix ? 'mix' : 'vocal',
        targets: { source: 'isolated-vocal' },
      };
      await saveLocalSong({ doc, melodyJson, instrumental: files.instrumental, vocal: files.vocal, mix: files.mix, lyrics: lyricsText });
      await app.reloadRegistry();
      app.selectSong(id);
      if (thenSync) {
        await app.loadPack(true);
        app.go({ name: 'sync' });
      } else app.go({ name: 'home' });
    } catch (e) {
      say('bad', `Could not save the song: ${(e as Error).message}`);
    }
  };

  // Analyze again: the stems stored for the song.
  if (existing) {
    void (async () => {
      const [doc, inst, voc, mix] = await Promise.all([localSongDoc(existing.id), localSource(existing, 'instrumental'), localSource(existing, 'vocal'), localSource(existing, 'mix')]);
      if (destroyed) return;
      titleIn.value = existing.title;
      artistIn.value = existing.artist;
      files.instrumental = inst;
      files.vocal = voc;
      files.mix = mix;
      names.instrumental = doc?.files.instrumental ?? 'instrumental';
      names.vocal = doc?.files.vocal ?? 'vocal';
      names.mix = mix ? doc?.files.reference ?? 'full mix' : '';
      renderSlots();
      if (!inst || !voc) say('bad', 'The stored instrumental or vocal of this song is missing, so it cannot be analyzed again. Delete the song and add it again.');
    })();
  }
  renderSlots();

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:860px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: existing ? 'settings' : 'home' })), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, existing ? `Analyze again · ${existing.title}` : 'Add a song'),
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 18px' },
      existing
        ? 'Makes the pitch targets again from the files stored for this song, for example with a different level gate. The lyrics and their timing stay as they are.'
        : 'Pick the instrumental, the isolated lead vocal and, if you have it, the full song. This browser makes the pitch targets; the files are stored here and are not uploaded anywhere.',
    ),
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'row add-names' }, h('div', { class: 'field grow' }, h('label', null, 'Title'), titleIn), h('div', { class: 'field grow' }, h('label', null, 'Artist'), artistIn)),
      h('div', { class: 'row', style: 'margin-top:6px' }, icon('files', 'icon-sm'), h('div', { class: 'panel-title', style: 'margin:0' }, 'Song files')),
      slotsHost,
      existing ? null : drop,
      existing ? null : h('div', { class: 'field' }, h('label', null, 'Lyrics'), lyricsIn),
      h(
        'details',
        { class: 'small' },
        h('summary', { class: 'muted' }, 'Advanced'),
        h(
          'div',
          { class: 'row', style: 'margin-top:10px' },
          h('label', { class: 'muted small' }, 'Level gate (dB below the vocal’s loud level that still counts as singing)'),
          gateIn,
        ),
      ),
      msg,
      h('div', { class: 'row' }, analyzeBtn, cancelBtn),
      progress,
    ),
    reportHost,
  );

  return {
    el,
    destroy: () => {
      destroyed = true;
      run?.cancel();
    },
  };
}
