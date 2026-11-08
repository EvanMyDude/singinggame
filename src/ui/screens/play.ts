import { SongPlayer, type Pass } from '../../audio/sequencer';
import { previewNote } from '../../audio/synth';
import type { VoiceFrame } from '../../audio/pitch/tracker';
import { foldToOctaveOf } from '../../core/music';
import { ScoreEngine, THRESHOLDS, gradeFor, multiplierFor, type Judgment, type NoteResult, type Zone } from '../../core/scoring';
import { lyricWords, transposeSong, type Note, type Song } from '../../core/song';
import type { App, PlayConfig, Route, Screen } from '../app';
import { fmtInt, h, icon } from '../dom';
import { Highway, type TrailPt } from '../render/highway';
import type { AttemptResult } from './results';

interface PassState {
  pass: Pass;
  scorer: ScoreEngine;
  done: boolean;
}

export function playScreen(app: App, route: Route): Screen {
  if (route.name !== 'play') throw new Error('bad route');
  const config: PlayConfig = route.config;
  const base = app.songById(config.songId);
  if (!base) {
    queueMicrotask(() => app.go({ name: 'songs' }));
    return { el: h('div') };
  }
  const replay = config.replay;
  if (!replay && !app.micReady) {
    queueMicrotask(() => app.go({ name: 'setup', next: route }));
    return { el: h('div') };
  }

  const rt = app.rt();
  const song = transposeSong(base, config.transpose);
  const sec = config.section !== null ? song.sections[config.section] ?? null : null;
  const fromBeat = sec ? sec.startBeat : 0;
  const toBeat = sec ? sec.endBeat : song.totalBeats;
  const noteFrom = sec ? sec.noteFrom : 0;
  const noteTo = sec ? sec.noteTo : song.notes.length;
  const windowNotes = song.notes.slice(noteFrom, noteTo);
  const latency = app.latency();
  const fold = app.store.settings.foldOctaves;
  const practice = config.mode === 'practice';

  // ---------- DOM ----------
  const canvas = h('canvas', { 'aria-label': 'Note highway' });
  const scoreEl = h('span', { class: 'hud-score' }, '0');
  const multEl = h('span', { class: 'hud-mult x1' }, '×1');
  const accEl = h('b', null, '–');
  const streakEl = h('b', null, '0');
  const progressEl = h('i');
  const comboEl = h('div', { class: 'hud-combo', style: 'opacity:0' });
  const lyricLine = h('div', { class: 'lyric-line' });
  const lyricNext = h('div', { class: 'lyric-next' });
  const toastHost = h('div');

  const guideBtn = h('button', { class: 'btn', 'aria-pressed': String(config.guide), onclick: () => setGuide(!config.guide), title: 'Guide melody (G)' }, 'Melody');
  const backingBtn = h('button', { class: 'btn', 'aria-pressed': String(config.backing), onclick: () => setBacking(!config.backing), title: 'Backing band (B)' }, 'Band');
  const hearBtn = h('button', { class: 'btn', onclick: () => hearTarget(), title: 'Hear target note (H)' }, icon('note', 'kbd-icon'), 'Hear note', h('span', { class: 'kbd' }, 'H'));

  const hud = h(
    'div',
    { class: 'hud' },
    h('div', { class: 'hud-progress' }, progressEl),
    h(
      'div',
      { class: 'hud-top' },
      h('div', null, h('div', { class: 'hud-label' }, replay ? 'Replay' : 'Score'), h('div', null, scoreEl, replay ? null : multEl)),
      h(
        'div',
        { class: 'hud-stats' },
        h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'Accuracy'), accEl),
        h('div', { class: 'hud-stat' }, h('span', { class: 'hud-label' }, 'Streak'), streakEl),
      ),
    ),
    comboEl,
    h('div', { class: 'lyric-bar' }, lyricLine, lyricNext),
    h(
      'div',
      { class: 'play-tl' },
      h('button', { class: 'btn icon', onclick: () => pause(), 'aria-label': 'Pause (Esc)', title: 'Pause (Esc)' }, icon('pause', 'kbd-icon')),
      h(
        'span',
        { class: 'chip' },
        `${song.title}${sec ? ` · ${sec.name}` : ''}${config.speed !== 1 ? ` · ${Math.round(config.speed * 100)}%` : ''}${config.loop ? ' · loop' : ''}`,
      ),
    ),
    h(
      'div',
      { class: 'play-controls' },
      practice ? guideBtn : null,
      practice ? backingBtn : null,
      hearBtn,
      practice && config.loop && !replay ? h('button', { class: 'btn', onclick: () => void finish() }, 'Finish') : null,
    ),
    toastHost,
  );
  const root = h('div', { class: 'play-root' }, canvas, hud);

  const highway = new Highway(canvas, song, fromBeat, toBeat);
  highway.showNoteNames = app.store.settings.showNoteNames;

  // ---------- state ----------
  const judgments: (Judgment | undefined)[] = [];
  const liveZones: (Zone | undefined)[] = [];
  let trail: TrailPt[] = replay ? replay.trail : [];
  let head: { m: number; zone: Zone | null; t: number } | null = null;
  let hint: 'sharp' | 'flat' | null = null;
  let offSign = 0;
  let offSince = 0;
  let flashNote = -1;
  let flashUntil = 0;
  let displayedScore = 0;
  let lastMult = 1;
  let paused = false;
  let ended = false;
  let player: SongPlayer | null = null;
  const passes: PassState[] = [];
  const passAccuracies: number[] = [];
  let current: PassState | null = null;
  let firstNoteBeat = windowNotes[0]?.start ?? fromBeat;
  let countInFrom = fromBeat;
  let overlay: HTMLElement | null = null;

  const startPlayer = (startBeat: number) => {
    player = new SongPlayer(rt.engine, song, {
      speed: config.speed,
      fromBeat: startBeat,
      toBeat,
      loop: config.loop,
      guide: config.guide,
      backing: config.backing,
    });
    countInFrom = startBeat - player.countInBeats;
    firstNoteBeat = song.notes.find((n) => n.start >= startBeat - 1e-9 && n.index < noteTo)?.start ?? startBeat;
    const p = player;
    p.onPass = (pass) => {
      if (replay) return;
      if (current && startBeat !== fromBeat && pass.index === 0) {
        // Resuming mid-song: keep the same scorer, re-anchored to the new timeline.
        current.scorer.rebase(pass.t0, startBeat);
        current.pass = pass;
        return;
      }
      const scorer = new ScoreEngine(song, {
        t0: pass.t0,
        secPerBeat: p.secPerBeat,
        latency,
        frameInterval: rt.frameInterval,
        foldOctaves: fold,
        startBeat: fromBeat,
        noteFrom,
        noteTo,
      });
      const ps: PassState = { pass, scorer, done: false };
      passes.push(ps);
      current = ps;
      lastMult = 1;
      displayedScore = 0;
      // Timeline announcement, used by automated tests (a synthetic singer) and debugging.
      window.dispatchEvent(
        new CustomEvent('pitchline:pass', { detail: { t0: pass.t0, secPerBeat: p.secPerBeat, fromBeat, notes: windowNotes.map((n) => ({ midi: n.midi, start: n.start, beats: n.beats })) } }),
      );
      if (pass.index > 0) {
        for (let i = noteFrom; i < noteTo; i++) {
          judgments[i] = undefined;
          liveZones[i] = undefined;
        }
        trail = [];
      }
      if (practice && windowNotes[0]) {
        // Cue the first note of the section during the count-in.
        previewNote(rt.engine, windowNotes[0].midi, Math.min(1.2, p.secPerBeat * 1.5), pass.countInStart + 0.02);
      }
    };
    p.onEnd = () => {
      if (!config.loop) void finish();
    };
    p.start(0.15);
  };

  // ---------- live input ----------
  const onFrame = (f: VoiceFrame) => {
    if (paused || ended || !player) return;
    const comp = f.time - latency;
    // Route the frame to the pass whose timeline it belongs to.
    let ps: PassState | null = null;
    // A pass's count-in starts where the previous pass ends; frames within the boundary
    // tolerance still belong to the previous pass's last note.
    for (const q of passes) if (q.pass.countInStart + 0.15 <= comp) ps = q;
    if (!ps) return;
    const j = ps.scorer.ingest(f);
    const isCurrent = ps === current;
    if (isCurrent) {
      if (j.note >= 0 && j.zone) liveZones[j.note] = j.zone;
      const ref = j.note >= 0 ? song.notes[j.note]!.midi : refMidiAt(song, j.beat, noteFrom, noteTo);
      const m = f.voiced ? (fold && ref !== null ? foldToOctaveOf(f.displayMidi, ref) : f.displayMidi) : NaN;
      trail.push({ beat: j.beat, m, zone: f.voiced ? j.zone : null });
      if (trail.length > 20000) trail.splice(0, 5000);
      if (f.voiced) head = { m, zone: j.zone, t: performance.now() };
      // Sustained sharp/flat hint against the note being sung right now.
      const active = j.note >= 0 && j.beat >= song.notes[j.note]!.start - 0.05;
      if (f.voiced && active && Math.abs(j.cents) > THRESHOLDS.great) {
        const sign = Math.sign(j.cents);
        if (sign !== offSign) {
          offSign = sign;
          offSince = f.time;
        }
        if (f.time - offSince > 0.15) hint = sign > 0 ? 'sharp' : 'flat';
      } else if (f.voiced && j.note >= 0) {
        offSign = 0;
        hint = null;
      } else if (!f.voiced && f.time - offSince > 0.25) {
        offSign = 0;
        hint = null;
      }
    }
    // Advance every unfinished pass, not only the one this frame belongs to: otherwise a
    // looped pass would never finalize once frames start flowing to the next pass.
    for (const q of passes) {
      if (q.done) continue;
      for (const r of q.scorer.advance(f.time)) onNoteResult(q, r);
      checkPassDone(q, f.time);
    }
  };

  const onNoteResult = (ps: PassState, r: NoteResult) => {
    if (ps !== current) return;
    judgments[r.index] = r.judgment;
    if (r.judgment !== 'miss' || r.coverage > 0) {
      highway.popJudgment(r.judgment, r.midi, r.hold ? 'HOLD +' : undefined);
    }
    const mult = multiplierFor(ps.scorer.streak);
    if (mult > lastMult) {
      highway.comboBurst(`×${mult} COMBO`);
      multEl.classList.remove('bump');
      void multEl.offsetWidth;
      multEl.classList.add('bump');
    }
    lastMult = mult;
    const s = ps.scorer.streak;
    comboEl.style.opacity = s >= 2 ? '1' : '0';
    comboEl.className = `hud-combo ${s >= 8 ? 'hot' : ''} pop`;
    comboEl.replaceChildren(h('b', null, String(s)), ' combo');
  };

  const checkPassDone = (ps: PassState, frameTime: number) => {
    if (ps.done) return;
    if (!ps.scorer.done && frameTime - latency < ps.pass.end + 0.4) return;
    for (const r of ps.scorer.finishAll()) onNoteResult(ps, r);
    ps.done = true;
    if (config.loop) {
      const acc = ps.scorer.accuracyPct;
      passAccuracies.push(acc);
      const best = Math.max(...passAccuracies);
      toast(`Pass ${passAccuracies.length} · ${Math.round(acc)}%${passAccuracies.length > 1 ? ` · best ${Math.round(best)}%` : ''}`);
    }
  };

  const offFrame = replay ? () => {} : rt.onFrame(onFrame);

  // ---------- controls ----------
  const setGuide = (on: boolean) => {
    config.guide = on;
    guideBtn.setAttribute('aria-pressed', String(on));
    player?.setGuide(on);
  };
  const setBacking = (on: boolean) => {
    config.backing = on;
    backingBtn.setAttribute('aria-pressed', String(on));
    player?.setBacking(on);
  };

  const currentBeat = () => (player ? player.locate(rt.engine.heardTime()).beat : fromBeat);

  const hearTarget = () => {
    const b = currentBeat();
    const n = windowNotes.find((x) => x.start + x.beats > b + 0.1) ?? windowNotes[0];
    if (!n) return;
    previewNote(rt.engine, n.midi, 0.9);
    flashNote = n.index;
    flashUntil = performance.now() + 900;
  };

  const toast = (text: string) => {
    const t = h('div', { class: 'toast' }, text);
    toastHost.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  };

  const pause = () => {
    if (paused || ended) return;
    paused = true;
    const b = currentBeat();
    player?.stop();
    const resumeBeat = config.loop ? fromBeat : Math.max(fromBeat, Math.floor(b / song.beatsPerBar) * song.beatsPerBar);
    overlay = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'card stack' },
        h('h2', { style: 'font-size:26px' }, 'Paused'),
        h('p', { class: 'muted small', style: 'margin:0' }, config.loop ? 'Resume restarts this section.' : 'Resume picks up from the start of this bar with a count-in.'),
        h(
          'div',
          { class: 'stack', style: 'gap:8px' },
          h('button', { class: 'btn primary', onclick: () => resume(resumeBeat) }, 'Resume'),
          h('button', { class: 'btn', onclick: () => app.go({ name: 'play', config: { ...config } }) }, 'Restart'),
          practice && !replay ? h('button', { class: 'btn', onclick: () => void finish() }, 'Finish and see results') : null,
          h('button', { class: 'btn ghost', onclick: () => app.go({ name: 'songs', selectId: config.songId }) }, 'Quit to songs'),
        ),
        h('div', { class: 'faint tiny' }, h('span', { class: 'kbd' }, 'Esc'), ' pause · ', h('span', { class: 'kbd' }, 'H'), ' hear note', practice ? ' · ' : '', practice ? h('span', { class: 'kbd' }, 'G') : null, practice ? ' melody · ' : '', practice ? h('span', { class: 'kbd' }, 'B') : null, practice ? ' band' : ''),
      ),
    );
    root.appendChild(overlay);
  };

  const resume = (beat: number) => {
    overlay?.remove();
    overlay = null;
    paused = false;
    if (config.loop && current) {
      // Abandon the interrupted pass; a fresh one starts with the count-in.
      current.done = true;
      passes.length = 0;
      current = null;
    }
    startPlayer(beat);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'p') {
      e.preventDefault();
      if (paused) {
        if (e.key !== 'p') overlay?.querySelector<HTMLButtonElement>('.btn.primary')?.click();
      } else pause();
    } else if (e.key === 'h' || e.key === 'H') hearTarget();
    else if (practice && (e.key === 'g' || e.key === 'G')) setGuide(!config.guide);
    else if (practice && (e.key === 'b' || e.key === 'B')) setBacking(!config.backing);
  };
  window.addEventListener('keydown', onKey);
  const onVis = () => {
    if (document.hidden) pause();
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- finish ----------
  const finish = async () => {
    if (ended) return;
    ended = true;
    player?.stop(0.3);
    if (replay) {
      app.go({ name: 'results', result: replay.result });
      return;
    }
    // Prefer the last completed pass; otherwise score what we have.
    let ps = [...passes].reverse().find((p) => p.done) ?? current;
    if (!ps) {
      app.go({ name: 'songs', selectId: config.songId });
      return;
    }
    if (!ps.done) ps.scorer.finishAll();
    ps = ps!;
    const sc = ps.scorer;
    const accuracy = sc.accuracyPct;
    const grade = gradeFor(accuracy);
    const record = {
      date: Date.now(),
      score: Math.round(sc.score),
      accuracy,
      timing: sc.timingPct,
      grade,
      bestStreak: sc.bestStreak,
      mode: config.mode,
      speed: config.speed,
    } as const;
    const { previousBest, isNewBest } = app.store.recordAttempt(config.songId, { ...record });
    const result: AttemptResult = {
      config: { ...config, replay: undefined },
      song,
      score: record.score,
      accuracy,
      timing: record.timing,
      bestStreak: sc.bestStreak,
      grade,
      counts: { ...sc.counts },
      notes: [...sc.results].sort((a, b) => a.index - b.index),
      noteFrom,
      noteTo,
      passes: [...passAccuracies],
      previousBest,
      isNewBest,
      countsTowardBest: config.mode === 'sing' && config.speed === 1,
      replay: undefined,
    };
    result.replay = { trail: trail.slice(), judgments: judgments.slice(), result };
    setTimeout(() => app.go({ name: 'results', result }), 700);
    toast(config.loop ? 'Practice complete' : 'Song complete');
  };

  // ---------- render loop ----------
  const phrases = buildPhrases(song, noteFrom, noteTo);
  let shownPhrase = -1;
  let phraseSpans: { el: HTMLElement; from: number; to: number }[] = [];
  let raf = 0;
  let lastFrameT = performance.now();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - lastFrameT) / 1000);
    lastFrameT = nowMs;
    const beat = paused || !player ? lastBeat : currentBeat();
    lastBeat = beat;

    let headOut: { m: number; zone: Zone | null } | null = null;
    if (replay) {
      // Reveal the recorded attempt as the playhead passes it.
      for (const r of replay.result.notes) if (song.notes[r.index]!.start + song.notes[r.index]!.beats < beat) judgments[r.index] = r.judgment;
      const last = lastTrailBefore(trail, beat);
      if (last && Number.isFinite(last.m) && beat - last.beat < 0.15) {
        headOut = { m: last.m, zone: last.zone };
        const at = noteIndexAt(song, beat, noteFrom, noteTo);
        if (last.zone && beat >= song.notes[at]!.start) liveZones[at] = last.zone;
      }
    } else if (head && nowMs - head.t < 140) {
      headOut = { m: head.m, zone: head.zone };
    }

    highway.draw({
      beat,
      firstNoteBeat,
      countInFrom,
      judgments,
      liveZones,
      trail,
      head: headOut,
      hint: headOut ? hint : null,
      flashNote,
      flashUntil,
      now: nowMs,
    });

    // HUD.
    const sc = current?.scorer;
    if (replay) {
      scoreEl.textContent = fmtInt(replay.result.score);
      accEl.textContent = `${Math.round(replay.result.accuracy)}%`;
      streakEl.textContent = String(replay.result.bestStreak);
    } else if (sc) {
      displayedScore += (sc.score - displayedScore) * Math.min(1, dt * 10);
      if (Math.abs(sc.score - displayedScore) < 1) displayedScore = sc.score;
      scoreEl.textContent = fmtInt(displayedScore);
      const m = sc.multiplier;
      multEl.textContent = `×${m}`;
      multEl.classList.toggle('x1', m === 1);
      accEl.textContent = sc.results.length ? `${Math.round(sc.accuracyPct)}%` : '–';
      streakEl.textContent = String(sc.streak);
    }
    const prog = (beat - fromBeat) / (toBeat - fromBeat);
    progressEl.style.width = `${Math.max(0, Math.min(1, prog)) * 100}%`;

    // Lyrics.
    const idx = noteIndexAt(song, beat, noteFrom, noteTo);
    const pi = phrases.findIndex((p) => idx < p.noteTo);
    const phraseIdx = pi < 0 ? phrases.length - 1 : pi;
    if (phraseIdx !== shownPhrase && phrases.length) {
      shownPhrase = phraseIdx;
      const p = phrases[phraseIdx]!;
      phraseSpans = lyricWords(song.notes.slice(p.noteFrom, p.noteTo)).map((w) => ({
        el: h('span', null, w.text + ' '),
        from: w.noteFrom + p.noteFrom,
        to: w.noteTo + p.noteFrom,
      }));
      lyricLine.replaceChildren(...phraseSpans.map((s) => s.el));
      const nx = phrases[phraseIdx + 1];
      lyricNext.textContent = nx ? lyricWords(song.notes.slice(nx.noteFrom, nx.noteTo)).map((w) => w.text).join(' ') : '';
    }
    const active = song.notes.find((n) => n.index >= noteFrom && n.index < noteTo && beat >= n.start && beat < n.start + n.beats);
    for (const s of phraseSpans) {
      const now = active ? active.index >= s.from && active.index < s.to : false;
      const sung = !now && idx >= s.to - 1 && beat >= song.notes[s.to - 1]!.start + song.notes[s.to - 1]!.beats;
      const cls = now ? 'now' : sung ? 'sung' : '';
      if (s.el.className !== cls) s.el.className = cls;
    }
  };
  let lastBeat = fromBeat - 4;
  raf = requestAnimationFrame(frame);

  // Kick off (the route change came from a click, so audio is allowed to start).
  void rt.engine.resume().then(() => {
    if (!ended) startPlayer(fromBeat);
  });

  return {
    el: root,
    destroy: () => {
      ended = true;
      cancelAnimationFrame(raf);
      offFrame();
      player?.stop();
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

/** Index of the note at/just before `beat` within the window (for lyric progress). */
function noteIndexAt(song: Song, beat: number, from: number, to: number): number {
  let idx = from;
  for (let i = from; i < to; i++) {
    if (song.notes[i]!.start <= beat) idx = i;
    else break;
  }
  return idx;
}

function refMidiAt(song: Song, beat: number, from: number, to: number): number | null {
  let best: Note | null = null;
  let bestD = Infinity;
  for (let i = from; i < to; i++) {
    const n = song.notes[i]!;
    const d = beat < n.start ? n.start - beat : beat > n.start + n.beats ? beat - n.start - n.beats : 0;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best ? best.midi : null;
}

function lastTrailBefore(trail: readonly TrailPt[], beat: number): TrailPt | null {
  let lo = 0;
  let hi = trail.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trail[mid]!.beat <= beat) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? trail[ans]! : null;
}

/** Split the lyric into display lines at punctuation, rests and long phrases. */
export function buildPhrases(song: Song, from: number, to: number): { noteFrom: number; noteTo: number }[] {
  const out: { noteFrom: number; noteTo: number }[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const n = song.notes[i]!;
    const next = song.notes[i + 1];
    const punct = /[,.;:!?]$/.test(n.lyric);
    const gap = next ? next.start - (n.start + n.beats) >= 1 : true;
    const long = i - start >= 13;
    const lastInWindow = i === to - 1;
    // Do not break inside a word or before a melisma continuation.
    const midWord = n.lyric.endsWith('-') || (next !== undefined && next.lyric === '');
    if (lastInWindow || ((punct || gap || long) && !midWord)) {
      out.push({ noteFrom: start, noteTo: i + 1 });
      start = i + 1;
    }
  }
  return out;
}
