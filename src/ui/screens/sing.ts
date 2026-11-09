import type { VoiceFrame } from '../../audio/pitch/tracker';
import { TrackPlayer } from '../../audio/trackPlayer';
import { lineAt, wordAt, type LyricTiming } from '../../core/lyrics';
import { BeatMap, buildSections, fmtTime, melodyToSong } from '../../core/melody';
import { centsError, foldToOctaveOf, noteNameWithOctave } from '../../core/music';
import { ScoreEngine, THRESHOLDS, gradeFor, multiplierFor, zoneFor, type Judgment, type NoteResult, type Zone } from '../../core/scoring';
import type { Note, Song } from '../../core/song';
import { SONG } from '../../core/songpack';
import { SPEEDS, type Speed } from '../../core/storage';
import type { App, Route, Screen, SessionConfig } from '../app';
import { fmtInt, h, icon, segmented, slider } from '../dom';
import { Highway, type TrailPt } from '../render/highway';
import type { AttemptResult } from './results';

/**
 * Sing / Practice: the instrumental (or the reference track) plays while the note highway
 * shows the extracted melody and the live voice trail, lyrics follow the song clock, and in
 * Sing mode the ScoreEngine grades every target note. Practice adds speed and an A–B loop
 * and never scores.
 */
export function singScreen(app: App, route: Route): Screen {
  if (route.name !== 'sing') throw new Error('bad route');
  const config: SessionConfig = route.config;
  const practice = config.mode === 'practice';
  const pack = app.pack;
  if (!pack) {
    queueMicrotask(() => app.go({ name: 'home' }));
    return { el: h('div') };
  }
  if (!app.micReady) {
    queueMicrotask(() => app.go({ name: 'setup', next: route }));
    return { el: h('div') };
  }

  const rt = app.rt();
  const store = app.store;
  const melody = pack.melody;
  const map = new BeatMap(melody);
  const sections = buildSections(melody, pack.lyrics, pack.timing);
  const song: Song = melodyToSong(melody, SONG.id, SONG.title, sections, map);
  const latency = app.latency();
  const fold = store.settings.foldOctaves;
  const timing: LyricTiming | null = pack.timing;
  let speed: Speed = practice ? store.settings.speed : 1;
  let reference = store.settings.referenceVocal && !!pack.referenceUrl;

  // ---------- DOM ----------
  const canvas = h('canvas', { 'aria-label': 'Note highway' });
  const scoreEl = h('span', { class: 'hud-score' }, '0');
  const multEl = h('span', { class: 'hud-mult x1' }, '×1');
  const accEl = h('b', null, '–');
  const streakEl = h('b', null, '0');
  const youNote = h('b', { class: 'you-note' }, '–');
  const youCents = h('span', { class: 'you-cents' }, '');
  const comboEl = h('div', { class: 'hud-combo', style: 'opacity:0' });
  const lyricPrev = h('div', { class: 'lyric-prev' });
  const lyricNow = h('div', { class: 'lyric-now' });
  const lyricFill = h('i', { class: 'lyric-fill' });
  const lyricNext = h('div', { class: 'lyric-next' });
  const lyricNote = h('div', { class: 'lyric-note' });
  const timeEl = h('span', { class: 'time num' }, '0:00');
  const durEl = h('span', { class: 'time num faint' }, fmtTime(melody.duration));
  const progFill = h('i', { class: 'prog-fill' });
  const loopRegion = h('i', { class: 'loop-region', style: 'display:none' });
  const markA = h('i', { class: 'loop-mark a', style: 'display:none' }, 'A');
  const markB = h('i', { class: 'loop-mark b', style: 'display:none' }, 'B');
  const progress = h('div', { class: `prog ${practice ? 'seekable' : ''}`, role: 'slider', 'aria-label': 'Playback position', tabindex: practice ? '0' : '-1' }, progFill, loopRegion, markA, markB);
  const toastHost = h('div');
  const statusChip = h('span', { class: 'chip accent' }, practice ? 'Practice' : 'Sing');

  const playBtn = h('button', { class: 'btn primary icon-lg', onclick: () => void togglePlay(), 'aria-label': 'Play / pause (Space)', title: 'Play / pause (Space)' }, icon('play2'));
  const restartBtn = h('button', { class: 'btn icon', onclick: () => void restart(), 'aria-label': 'Restart (R)', title: 'Restart (R)' }, icon('restart'));
  const refBtn = h(
    'button',
    { class: 'btn toggle', 'aria-pressed': String(reference), disabled: !pack.referenceUrl, onclick: () => setReference(!reference), title: pack.referenceUrl ? 'Reference vocal (V)' : 'Add the reference track in Settings' },
    'Reference vocal',
    h('span', { class: 'kbd' }, 'V'),
  );
  const speedSeg = segmented(
    SPEEDS.map((v) => ({ value: v, label: `${Math.round(v * 100)}%` })),
    speed,
    (v) => setSpeed(v),
    'Playback speed',
  );
  const setABtn = h('button', { class: 'btn', onclick: () => setA(), title: 'Set loop start at the current position (A)' }, 'Set A');
  const setBBtn = h('button', { class: 'btn', onclick: () => setB(), title: 'Set loop end at the current position (B)' }, 'Set B');
  const loopBtn = h('button', { class: 'btn toggle', 'aria-pressed': 'false', disabled: true, onclick: () => setLoopOn(!loopOn), title: 'Loop A–B (L)' }, 'Loop A–B', h('span', { class: 'kbd' }, 'L'));
  const clearBtn = h('button', { class: 'btn ghost', onclick: () => clearLoop(), disabled: true }, 'Clear');
  const loopLabel = h('span', { class: 'faint tiny num' }, '');
  const volVal = h('span', { class: 'val' }, `${Math.round(store.settings.musicVol * 100)}%`);
  const volSlider = slider({
    min: 0,
    max: 1,
    step: 0.01,
    value: store.settings.musicVol,
    ariaLabel: 'Music volume',
    onInput: (v) => {
      volVal.textContent = `${Math.round(v * 100)}%`;
      store.updateSettings({ musicVol: v });
      player?.setVolume(v);
    },
  });
  const finishBtn = h('button', { class: 'btn', onclick: () => void finish(), title: 'End the run now and see results' }, 'Finish');

  const hud = h(
    'div',
    { class: 'hud' },
    h(
      'div',
      { class: 'hud-top' },
      h(
        'div',
        { class: 'hud-title' },
        h('div', { class: 'row', style: 'gap:8px' }, h('button', { class: 'btn ghost small', onclick: () => leave(), 'aria-label': 'Back to home (Esc)' }, icon('back', 'kbd-icon'), 'Home'), statusChip),
        h('div', { class: 'song-name' }, SONG.title),
      ),
      practice
        ? h('div', { class: 'hud-stats' }, h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'You'), h('div', { class: 'you' }, youNote, youCents)))
        : h(
            'div',
            { class: 'hud-stats' },
            h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'Score'), h('div', null, scoreEl, multEl)),
            h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'Accuracy'), accEl),
            h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'Streak'), streakEl),
            h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'You'), h('div', { class: 'you' }, youNote, youCents)),
          ),
    ),
    comboEl,
    h('div', { class: 'lyrics' }, lyricPrev, h('div', { class: 'lyric-now-wrap' }, lyricNow, lyricFill), lyricNext, lyricNote),
    h(
      'div',
      { class: 'transport' },
      h('div', { class: 'transport-row' }, timeEl, progress, durEl),
      h(
        'div',
        { class: 'transport-row controls' },
        playBtn,
        restartBtn,
        refBtn,
        practice ? speedSeg : null,
        practice ? h('div', { class: 'loop-controls' }, setABtn, setBBtn, loopBtn, clearBtn, loopLabel) : null,
        h('div', { class: 'grow' }),
        h('div', { class: 'row vol', style: 'flex-wrap:nowrap' }, icon('speaker', 'kbd-icon'), volSlider, volVal),
        practice ? null : finishBtn,
      ),
    ),
    toastHost,
  );
  const root = h('div', { class: 'play-root' }, canvas, hud);

  const highway = new Highway(canvas, song, 0, song.totalBeats);
  highway.showNoteNames = store.settings.showNoteNames;

  // ---------- state ----------
  const judgments: (Judgment | undefined)[] = [];
  const liveZones: (Zone | undefined)[] = [];
  let trail: TrailPt[] = [];
  let head: { m: number; zone: Zone | null; t: number } | null = null;
  let hint: 'sharp' | 'flat' | null = null;
  let offSign = 0;
  let offSince = 0;
  let displayedScore = 0;
  let lastMult = 1;
  let ended = false;
  let finishing = false;
  let player: TrackPlayer | null = null;
  let scorer: ScoreEngine | null = null;
  let loopA: number | null = config.loop?.a ?? null;
  let loopB: number | null = config.loop?.b ?? null;
  let loopOn = !!config.loop;
  let lastSaved = 0;
  let lastVoicedAt = 0;
  let shownLine = -2;
  let wordSpans: HTMLElement[] = [];

  const toast = (text: string) => {
    const t = h('div', { class: 'toast' }, text);
    toastHost.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  };

  // ---------- player ----------
  const p = new TrackPlayer(rt.engine, pack.instrumentalUrl, pack.referenceUrl, {
    referenceOffset: melody.referenceOffset,
    onEnded: () => void onEnded(),
    onLoop: () => {
      trail = [];
    },
    onError: (m) => toast(m),
  });
  player = p;
  app.activePlayer = p;
  p.setVolume(store.settings.musicVol);
  p.setRate(speed);
  p.setReference(reference);
  p.setLoop(loopA, loopB, loopOn);
  updateLoopUi();

  const startAt = Math.max(0, Math.min(melody.duration - 1, config.startAt ?? 0));
  void p
    .load()
    .then(async () => {
      if (ended) return;
      p.seek(loopOn && loopA !== null ? loopA : startAt);
      await p.play();
      updatePlayUi();
    })
    .catch((e: Error) => toast(`Could not load the song: ${e.message}`));

  const newScorer = () => {
    if (practice) return;
    const t0 = p.ctxTimeAt(map.seconds(0));
    if (!Number.isFinite(t0)) return;
    scorer = new ScoreEngine(song, {
      t0,
      secPerBeat: map.secPerBeat / speed,
      latency,
      frameInterval: rt.frameInterval,
      foldOctaves: fold,
      startBeat: 0,
    });
    for (let i = 0; i < song.notes.length; i++) {
      judgments[i] = undefined;
      liveZones[i] = undefined;
    }
    trail = [];
    displayedScore = 0;
    lastMult = 1;
    comboEl.style.opacity = '0';
  };

  /** Keep the scorer's time base on the media clock (it drifts after pauses and stalls). */
  const syncScorer = () => {
    if (!scorer || !p.clockReady) return;
    const t0 = p.ctxTimeAt(map.seconds(0));
    if (Number.isFinite(t0) && Math.abs(t0 - scorer.t0) > 0.02) scorer.rebase(t0, 0);
  };

  // ---------- live input ----------
  const nearestNote = (beat: number): Note | null => {
    let best: Note | null = null;
    let bestD = 0.3; // beats of tolerance around a target
    for (const n of song.notes) {
      const d = beat < n.start ? n.start - beat : beat > n.start + n.beats ? beat - n.start - n.beats : 0;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
      if (n.start > beat + 1) break;
    }
    return best;
  };

  const onFrame = (f: VoiceFrame) => {
    if (ended || p.paused || !p.clockReady) return;
    const songT = p.songTimeAt(f.time - latency);
    if (!Number.isFinite(songT)) return;
    const beat = map.beat(songT);
    if (f.voiced) {
      lastVoicedAt = performance.now();
      youNote.textContent = noteNameWithOctave(f.displayMidi);
      const c = Math.round((f.displayMidi - Math.round(f.displayMidi)) * 100);
      youCents.textContent = `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c)}¢`;
    }
    if (scorer) {
      syncScorer();
      const j = scorer.ingest(f);
      if (j.note >= 0 && j.zone) liveZones[j.note] = j.zone;
      const ref = j.note >= 0 ? song.notes[j.note]!.midi : (nearestNote(j.beat)?.midi ?? null);
      pushTrail(f, j.beat, ref, j.note >= 0 ? j.cents : NaN, j.zone);
      for (const r of scorer.advance(f.time)) onNoteResult(r);
    } else {
      const n = nearestNote(beat);
      const cents = f.voiced && n ? centsError(f.midi, n.midi, fold) : NaN;
      const zone = Number.isFinite(cents) ? zoneFor(Math.abs(cents)) : null;
      if (n && zone && beat >= n.start && beat < n.start + n.beats) liveZones[n.index] = zone;
      pushTrail(f, beat, n?.midi ?? null, cents, zone);
    }
  };

  const pushTrail = (f: VoiceFrame, beat: number, ref: number | null, cents: number, zone: Zone | null) => {
    const m = f.voiced ? (fold && ref !== null ? foldToOctaveOf(f.displayMidi, ref) : f.displayMidi) : NaN;
    trail.push({ beat, m, zone: f.voiced ? zone : null });
    if (trail.length > 20000) trail.splice(0, 5000);
    if (f.voiced) head = { m, zone, t: performance.now() };
    if (f.voiced && Number.isFinite(cents) && Math.abs(cents) > THRESHOLDS.great) {
      const sign = Math.sign(cents);
      if (sign !== offSign) {
        offSign = sign;
        offSince = f.time;
      }
      if (f.time - offSince > 0.15) hint = sign > 0 ? 'sharp' : 'flat';
    } else if (f.voiced && Number.isFinite(cents)) {
      offSign = 0;
      hint = null;
    } else if (!f.voiced && f.time - offSince > 0.25) {
      offSign = 0;
      hint = null;
    }
  };

  const onNoteResult = (r: NoteResult) => {
    if (!scorer) return;
    judgments[r.index] = r.judgment;
    if (r.judgment !== 'miss' || r.coverage > 0) highway.popJudgment(r.judgment, r.midi, r.hold ? 'HOLD +' : undefined);
    const mult = multiplierFor(scorer.streak);
    if (mult > lastMult) {
      highway.comboBurst(`×${mult} COMBO`);
      multEl.classList.remove('bump');
      void multEl.offsetWidth;
      multEl.classList.add('bump');
    }
    lastMult = mult;
    const s = scorer.streak;
    comboEl.style.opacity = s >= 2 ? '1' : '0';
    comboEl.className = `hud-combo ${s >= 8 ? 'hot' : ''} pop`;
    comboEl.replaceChildren(h('b', null, String(s)), ' combo');
  };

  const offFrame = rt.onFrame(onFrame);
  const offStore = store.onChange(() => {
    highway.showNoteNames = store.settings.showNoteNames;
  });

  // ---------- controls ----------
  const updatePlayUi = () => {
    playBtn.replaceChildren(icon(p.paused ? 'play2' : 'pause'));
    playBtn.setAttribute('aria-label', p.paused ? 'Play (Space)' : 'Pause (Space)');
    statusChip.textContent = p.paused ? (practice ? 'Practice · paused' : 'Paused') : practice ? 'Practice' : 'Sing';
  };

  const togglePlay = async () => {
    if (ended) return;
    if (p.paused) {
      await p.play();
      if (!practice && !scorer) newScorer();
    } else p.pause();
    updatePlayUi();
  };

  const restart = async () => {
    if (ended) return;
    p.seek(loopOn && loopA !== null ? loopA : 0);
    trail = [];
    scorer = null;
    for (let i = 0; i < song.notes.length; i++) {
      judgments[i] = undefined;
      liveZones[i] = undefined;
    }
    if (p.paused) await p.play();
    updatePlayUi();
  };

  const setReference = (on: boolean) => {
    if (!pack.referenceUrl) return;
    reference = on;
    refBtn.setAttribute('aria-pressed', String(on));
    p.setReference(on);
    store.updateSettings({ referenceVocal: on });
  };

  const setSpeed = (v: Speed) => {
    speed = v;
    p.setRate(v);
    store.updateSettings({ speed: v });
    speedSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === v)));
  };

  function updateLoopUi(): void {
    const d = melody.duration || 1;
    const has = loopA !== null && loopB !== null;
    loopBtn.disabled = !has;
    loopBtn.setAttribute('aria-pressed', String(loopOn && has));
    clearBtn.disabled = loopA === null && loopB === null;
    markA.style.display = loopA === null ? 'none' : '';
    markB.style.display = loopB === null ? 'none' : '';
    if (loopA !== null) markA.style.left = `${(loopA / d) * 100}%`;
    if (loopB !== null) markB.style.left = `${(loopB / d) * 100}%`;
    loopRegion.style.display = has ? '' : 'none';
    if (has) {
      loopRegion.style.left = `${(loopA! / d) * 100}%`;
      loopRegion.style.width = `${((loopB! - loopA!) / d) * 100}%`;
      loopRegion.classList.toggle('on', loopOn);
    }
    loopLabel.textContent = has ? `${fmtTime(loopA!)} – ${fmtTime(loopB!)}${loopOn ? ' · looping' : ''}` : loopA !== null ? `A ${fmtTime(loopA)}` : loopB !== null ? `B ${fmtTime(loopB)}` : '';
  }

  const setA = () => {
    loopA = Math.round(p.rawTime() * 10) / 10;
    if (loopB !== null && loopB <= loopA + 0.2) loopB = null;
    p.setLoop(loopA, loopB, loopOn);
    updateLoopUi();
    toast(`A set at ${fmtTime(loopA)}`);
  };
  const setB = () => {
    loopB = Math.round(p.rawTime() * 10) / 10;
    if (loopA !== null && loopB <= loopA + 0.2) {
      // B before A: treat the two marks as the section in time order.
      const a = loopB;
      loopB = loopA;
      loopA = a;
    }
    if (loopA === null) {
      loopA = 0;
    }
    loopOn = true;
    p.setLoop(loopA, loopB, loopOn);
    updateLoopUi();
    toast(`Looping ${fmtTime(loopA)} – ${fmtTime(loopB)}`);
    if (p.rawTime() < loopA || p.rawTime() > loopB) p.seek(loopA);
  };
  const setLoopOn = (on: boolean) => {
    if (loopA === null || loopB === null) return;
    loopOn = on;
    p.setLoop(loopA, loopB, loopOn);
    updateLoopUi();
    if (on && (p.rawTime() < loopA || p.rawTime() > loopB)) p.seek(loopA);
  };
  const clearLoop = () => {
    loopA = loopB = null;
    loopOn = false;
    p.setLoop(null, null, false);
    updateLoopUi();
  };

  const seekFromPointer = (e: PointerEvent) => {
    const r = progress.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    p.seek(k * melody.duration);
    trail = [];
  };
  if (practice) {
    progress.addEventListener('pointerdown', (e) => {
      seekFromPointer(e);
      const move = (ev: PointerEvent) => seekFromPointer(ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  const leave = () => app.go({ name: 'home' });

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        void togglePlay();
        break;
      case 'Escape':
        leave();
        break;
      case 'r':
      case 'R':
        void restart();
        break;
      case 'v':
      case 'V':
        setReference(!reference);
        break;
      case 'a':
      case 'A':
        if (practice) setA();
        break;
      case 'b':
      case 'B':
        if (practice) setB();
        break;
      case 'l':
      case 'L':
        if (practice) setLoopOn(!loopOn);
        break;
      case '1':
      case '2':
      case '3':
        if (practice) setSpeed(SPEEDS[Number(e.key) - 1]!);
        break;
      case 'ArrowLeft':
        if (practice) p.seek(p.rawTime() - 5);
        break;
      case 'ArrowRight':
        if (practice) p.seek(p.rawTime() + 5);
        break;
    }
  };
  window.addEventListener('keydown', onKey);
  const onVis = () => {
    if (document.hidden && !p.paused) {
      p.pause();
      updatePlayUi();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- finish ----------
  const onEnded = async () => {
    if (practice) {
      updatePlayUi();
      toast('End of song · R to go again');
      store.setLastPosition(SONG.id, 0);
      return;
    }
    await finish();
  };

  const finish = async () => {
    if (ended || finishing) return;
    finishing = true;
    const sc = scorer;
    if (!sc) {
      ended = true;
      app.go({ name: 'home' });
      return;
    }
    // Voice frames trail the audio by the round-trip latency: keep listening that long so
    // the last note is not cut short, then score.
    await new Promise((r) => setTimeout(r, (latency + 0.25) * 1000));
    if (ended) return;
    ended = true;
    p.pause();
    for (const r of sc.finishAll()) onNoteResult(r);
    const accuracy = sc.accuracyPct;
    const grade = gradeFor(accuracy);
    const record = {
      date: Date.now(),
      score: Math.round(sc.score),
      accuracy,
      timing: sc.timingPct,
      grade,
      bestStreak: sc.bestStreak,
      mode: 'sing' as const,
      speed: 1,
    };
    const { previousBest, isNewBest } = store.recordAttempt(SONG.id, { ...record });
    store.setLastPosition(SONG.id, 0);
    const result: AttemptResult = {
      config: { ...config },
      song,
      sections,
      score: record.score,
      accuracy,
      timing: record.timing,
      bestStreak: sc.bestStreak,
      grade,
      counts: { ...sc.counts },
      notes: [...sc.results].sort((a, b) => a.index - b.index),
      previousBest,
      isNewBest,
    };
    toast('Song complete');
    setTimeout(() => app.go({ name: 'results', result }), 700);
  };

  // ---------- lyrics ----------
  const renderLyrics = (t: number) => {
    if (!pack.lyrics) {
      if (shownLine !== -3) {
        shownLine = -3;
        lyricNow.textContent = '';
        lyricNote.textContent = 'No lyrics loaded. Add lyrics.txt in Settings → Song files.';
      }
      return;
    }
    if (!timing) {
      if (shownLine !== -3) {
        shownLine = -3;
        lyricNow.textContent = '';
        lyricNote.textContent = 'Lyrics are not synced yet. Settings → Sync lyrics takes a few minutes.';
      }
      return;
    }
    const li = lineAt(timing, t);
    if (li !== shownLine) {
      shownLine = li;
      const lines = pack.lyrics.lines;
      lyricPrev.textContent = li > 0 ? lines[li - 1]!.text : '';
      lyricNext.textContent = li + 1 < lines.length ? lines[li + 1]!.text : '';
      const cur = li >= 0 ? lines[li]! : null;
      if (cur && timing.lines[li]!.words) {
        wordSpans = cur.text.split(' ').map((w) => h('span', null, `${w} `));
        lyricNow.replaceChildren(...wordSpans);
      } else {
        wordSpans = [];
        lyricNow.textContent = cur ? cur.text : li < 0 && lines[0] ? '♪' : '';
      }
      lyricNote.textContent = '';
    }
    if (li >= 0) {
      const l = timing.lines[li]!;
      if (wordSpans.length) {
        const wi = wordAt(timing, li, t);
        wordSpans.forEach((s, i) => {
          const cls = i < wi ? 'sung' : i === wi ? 'now' : '';
          if (s.className !== cls) s.className = cls;
        });
        lyricFill.style.width = '0';
      } else {
        const frac = Number.isFinite(l.end) && l.end > l.start ? (t - l.start) / (l.end - l.start) : 0;
        lyricFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      }
    } else lyricFill.style.width = '0';
  };

  // ---------- render loop ----------
  let raf = 0;
  let lastFrameT = performance.now();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - lastFrameT) / 1000);
    lastFrameT = nowMs;
    const t = p.time;
    const beat = map.beat(t);
    if (!practice && !scorer && !p.paused && p.clockReady) newScorer();

    const headOut = head && nowMs - head.t < 140 ? { m: head.m, zone: head.zone } : null;
    highway.draw({
      beat,
      firstNoteBeat: -1e9,
      countInFrom: -1e9,
      judgments,
      liveZones,
      trail,
      head: headOut,
      hint: headOut ? hint : null,
      cues: EMPTY,
      flashNote: -1,
      flashUntil: 0,
      now: nowMs,
    });

    if (scorer) {
      displayedScore += (scorer.score - displayedScore) * Math.min(1, dt * 10);
      if (Math.abs(scorer.score - displayedScore) < 1) displayedScore = scorer.score;
      scoreEl.textContent = fmtInt(displayedScore);
      const m = scorer.multiplier;
      multEl.textContent = `×${m}`;
      multEl.classList.toggle('x1', m === 1);
      accEl.textContent = scorer.results.length ? `${Math.round(scorer.accuracyPct)}%` : '–';
      streakEl.textContent = String(scorer.streak);
    }
    if (nowMs - lastVoicedAt > 400) {
      youNote.textContent = '–';
      youCents.textContent = '';
    }
    timeEl.textContent = fmtTime(t);
    progFill.style.width = `${Math.max(0, Math.min(1, t / (melody.duration || 1))) * 100}%`;
    progress.setAttribute('aria-valuenow', String(Math.round(t)));
    renderLyrics(t);
    if (!p.paused && nowMs - lastSaved > 5000) {
      lastSaved = nowMs;
      store.setLastPosition(SONG.id, t);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    el: root,
    destroy: () => {
      ended = true;
      cancelAnimationFrame(raf);
      offFrame();
      offStore();
      if (!p.paused && p.duration) store.setLastPosition(SONG.id, p.rawTime());
      p.destroy();
      if (app.activePlayer === p) app.activePlayer = null;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

const EMPTY: ReadonlySet<number> = new Set();
