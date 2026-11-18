import { BeatMap, buildSections, fmtTime, melodyToSong } from '../../core/melody';
import { centsError, foldToOctaveOf } from '../../core/music';
import { deleteTake, getTakeMeta, listTakes, loadTake, updateTake, type TakeMeta } from '../../core/recordings';
import { zoneFor, type Zone } from '../../core/scoring';
import type { Note, Song } from '../../core/song';
import { loadMelody } from '../../core/songpack';
import { frameAt, mixTake, songTimeAt, suggestVocalGain, type TakeAudio } from '../../core/take';
import { wavBlob } from '../../core/wav';
import type { App, Route, Screen } from '../app';
import { backButton, downloadBlob, h, icon, slider } from '../dom';
import { Highway, type TrailPt } from '../render/highway';
import { PitchGraph, defaultView, followView } from '../render/pitchGraph';

/**
 * Recorded takes: the list, and a review page that plays a take back with the voice trail
 * drawn over the song's target highway (or the pitch graph for a Pitch Monitor take). Takes
 * live in this browser; the WAV downloads are the way to keep them.
 */

const MODE_LABEL: Record<TakeMeta['mode'], string> = { sing: 'Sing', practice: 'Practice', monitor: 'Pitch Monitor' };

function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

function fileBase(meta: TakeMeta): string {
  const d = new Date(meta.createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${meta.songId ?? 'pitch-monitor'}-${stamp}`;
}

function speedsLabel(meta: TakeMeta): string | null {
  const slow = meta.speeds.filter((s) => s !== 1);
  return slow.length ? `at ${meta.speeds.map((s) => `${Math.round(s * 100)}%`).join(', ')}` : null;
}

async function confirmDelete(meta: TakeMeta): Promise<boolean> {
  if (!confirm(`Delete “${meta.name}”? It is removed from this browser; downloaded copies are not affected.`)) return false;
  await deleteTake(meta.id);
  return true;
}

export function recordingsScreen(app: App): Screen {
  const list = h('div', { class: 'stack', style: 'gap:10px' }, h('p', { class: 'muted' }, 'Loading…'));
  const usage = h('span');

  const render = async () => {
    const takes = await listTakes();
    if (!takes.length) {
      list.replaceChildren(
        h(
          'div',
          { class: 'card' },
          h('p', { style: 'margin:0' }, 'No recordings yet.'),
          h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Turn on Record in Sing, Practice or the Pitch Monitor. Your voice and the music you hear are saved here, in this browser.'),
        ),
      );
    } else {
      list.replaceChildren(
        ...takes.map((m) =>
          h(
            'div',
            { class: 'card take-row' },
            h(
              'button',
              { class: 'take-open', onclick: () => app.go({ name: 'take', id: m.id }), 'aria-label': `Open ${m.name}` },
              h('div', { class: 'take-name' }, m.name),
              h(
                'div',
                { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:6px' },
                h('span', { class: 'chip' }, MODE_LABEL[m.mode]),
                h('span', { class: 'chip' }, fmtTime(m.duration)),
                speedsLabel(m) ? h('span', { class: 'chip' }, speedsLabel(m)!) : null,
                m.result ? h('span', { class: `grade-badge grade-${m.result.grade}`, title: `${m.result.score} points` }, m.result.grade) : null,
                h('span', { class: 'chip' }, fmtBytes(m.bytes)),
              ),
            ),
            h(
              'button',
              {
                class: 'btn danger small',
                onclick: async () => {
                  if (await confirmDelete(m)) void render();
                },
              },
              'Delete',
            ),
          ),
        ),
      );
    }
    const total = takes.reduce((s, m) => s + m.bytes, 0);
    usage.textContent = takes.length ? ` ${takes.length} recording${takes.length === 1 ? '' : 's'}, ${fmtBytes(total)}.` : '';
  };
  void render();

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:900px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Recordings'),
    h('p', { class: 'muted', style: 'margin:0 0 18px' }, 'Recordings are kept only in this browser and can be cleared with its site data. Download the ones you want to keep.', usage),
    list,
  );
  return { el };
}

/** Plays a take: the music and the voice as two sources started together, so the voice level can change live. */
class TakePlayer {
  private readonly ctx: AudioContext;
  private readonly music: AudioBuffer | null;
  private readonly voice: AudioBuffer;
  private readonly voiceGain: GainNode;
  private readonly out: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  playing = false;
  onEnded: () => void = () => {};

  constructor(ctx: AudioContext, take: TakeAudio, vocalGain: number) {
    this.ctx = ctx;
    const n = take.mic.length;
    this.voice = ctx.createBuffer(1, Math.max(1, n), take.sampleRate);
    const v = this.voice.getChannelData(0);
    for (let i = 0; i < n; i++) v[i] = take.mic[i]! / 32768;
    if (take.music && take.musicChannels) {
      const ch = take.musicChannels;
      this.music = ctx.createBuffer(ch, Math.max(1, n), take.sampleRate);
      for (let c = 0; c < ch; c++) {
        const d = this.music.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] = take.music[i * ch + c]! / 32768;
      }
    } else this.music = null;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = vocalGain;
    this.voiceGain.connect(this.out);
  }

  get duration(): number {
    return this.voice.duration;
  }

  /** Take time (s) being heard. */
  get time(): number {
    if (!this.playing) return this.offset;
    const lag = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.min(this.duration, Math.max(0, this.offset + this.ctx.currentTime - this.startedAt - lag));
  }

  setVocalGain(g: number): void {
    this.voiceGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const at = this.ctx.currentTime + 0.05;
    const mk = (buf: AudioBuffer, dest: AudioNode) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(dest);
      s.start(at, this.offset);
      return s;
    };
    this.sources = [mk(this.voice, this.voiceGain)];
    if (this.music) this.sources.push(mk(this.music, this.out));
    const first = this.sources[0]!;
    first.onended = () => {
      if (this.sources[0] !== first) return;
      this.offset = this.duration;
      this.stopSources();
      this.onEnded();
    };
    this.startedAt = at;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.time;
    this.stopSources();
  }

  seek(t: number): void {
    const was = this.playing;
    this.pause();
    this.offset = Math.max(0, Math.min(this.duration, t));
    if (was) void this.play();
  }

  private stopSources(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.sources = [];
    this.playing = false;
  }

  destroy(): void {
    this.stopSources();
    this.out.disconnect();
    this.voiceGain.disconnect();
  }
}

/** The voice trail over the target highway, as it was sung, for take time `t`. */
function trailAt(take: TakeAudio, song: Song, map: BeatMap, t: number, fold: boolean): { trail: TrailPt[]; head: { m: number; zone: Zone | null } | null } {
  const f = take.frames;
  const i = frameAt(f.t, t);
  const trail: TrailPt[] = [];
  let head: { m: number; zone: Zone | null } | null = null;
  const nearest = (beat: number): Note | null => {
    let best: Note | null = null;
    let bestD = 0.3;
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
  for (let j = i; j >= 0 && f.t[j]! >= t - 8; j--) {
    const s = f.song[j]!;
    // Stop at a seek or a loop jump: what was sung before it belongs to another pass.
    if (j < i) {
      const later = f.song[j + 1]!;
      if (!Number.isFinite(s) || !Number.isFinite(later) || later < s - 0.3 || later > s + 1) break;
    }
    if (!Number.isFinite(s)) break;
    const beat = map.beat(s);
    const m = f.midi[j]!;
    const n = Number.isFinite(m) ? nearest(beat) : null;
    const cents = n ? centsError(m, n.midi, fold) : NaN;
    const zone = Number.isFinite(cents) ? zoneFor(Math.abs(cents)) : null;
    const shown = Number.isFinite(m) ? (fold && n ? foldToOctaveOf(m, n.midi) : m) : NaN;
    trail.push({ beat, m: shown, zone });
    if (!head && Number.isFinite(m) && t - f.t[j]! < 0.14) head = { m: shown, zone };
  }
  trail.reverse();
  return { trail, head };
}

export function takeScreen(app: App, route: Route): Screen {
  if (route.name !== 'take') throw new Error('bad route');
  const id = route.id;
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading the recording…'));
  const titleEl = h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Recording');
  let cleanup: () => void = () => {};
  let destroyed = false;

  const el = h('div', { class: 'screen', style: 'max-width:1100px' }, h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'recordings' })), h('div', { class: 'spacer' })), titleEl, body);

  void (async () => {
    let meta = await getTakeMeta(id);
    if (!meta) {
      body.replaceChildren(h('div', { class: 'notice warn' }, 'This recording is not in this browser any more.'));
      return;
    }
    titleEl.textContent = meta.name;
    let take: TakeAudio;
    try {
      take = await loadTake(meta);
    } catch (e) {
      body.replaceChildren(h('div', { class: 'notice bad' }, (e as Error).message));
      return;
    }
    if (destroyed) return;

    // What to draw: the song's highway when its targets are here, else the pitch graph.
    const def = meta.songId ? app.songs.find((s) => s.id === meta!.songId) ?? null : null;
    const melody = def ? await loadMelody(def) : null;
    if (destroyed) return;
    const canvas = h('canvas', { class: 'take-canvas', 'aria-label': melody ? 'Your pitch over the target melody' : 'Your pitch' });
    const fold = app.store.settings.foldOctaves;
    let drawFrame: (t: number) => void;
    if (melody && def) {
      const map = new BeatMap(melody);
      const song = melodyToSong(melody, def.id, def.title, buildSections(melody, null, null), map);
      const highway = new Highway(canvas, song, 0, song.totalBeats);
      highway.showNoteNames = app.store.settings.showNoteNames;
      const none: (undefined)[] = [];
      // The first frames of a take come before the song clock settles and carry no song time;
      // until then the view holds where the take's song begins instead of showing nothing.
      let first: { t: number; s: number } | null = null;
      for (let j = 0; j < take.frames.t.length && !first; j++) {
        if (Number.isFinite(take.frames.song[j]!)) first = { t: take.frames.t[j]!, s: take.frames.song[j]! };
      }
      drawFrame = (t) => {
        let s = songTimeAt(take.frames, t);
        if (!Number.isFinite(s) && first && t <= first.t) s = first.s - (first.t - t);
        const { trail, head } = Number.isFinite(s) ? trailAt(take, song, map, t, fold) : { trail: [], head: null };
        highway.draw({
          beat: Number.isFinite(s) ? map.beat(s) : -1e3,
          firstNoteBeat: -1e9,
          countInFrom: -1e9,
          judgments: none,
          liveZones: none,
          trail,
          head,
          hint: null,
          cues: new Set<number>(),
          flashNote: -1,
          flashUntil: 0,
          now: performance.now(),
        });
      };
    } else {
      const midis = Array.from(take.frames.midi).filter(Number.isFinite);
      const graph = new PitchGraph(canvas, defaultView(midis.length ? { low: Math.min(...midis), high: Math.max(...midis) } : null));
      let pushedTo = -1;
      drawFrame = (t) => {
        const i = frameAt(take.frames.t, t);
        if (i < pushedTo) {
          graph.clear();
          pushedTo = Math.max(-1, frameAt(take.frames.t, t - graph.windowSec));
        }
        for (let j = pushedTo + 1; j <= i; j++) {
          const m = take.frames.midi[j]!;
          graph.push(take.frames.t[j]!, m);
          if (Number.isFinite(m)) graph.view = followView(graph.view, m);
        }
        pushedTo = Math.max(pushedTo, i);
        const cur = i >= 0 && Number.isFinite(take.frames.midi[i]!) ? take.frames.midi[i]! : null;
        graph.draw(t, cur);
      };
    }

    const auto = suggestVocalGain(take.mic, take.music, take.musicChannels);
    let gain = meta.vocalGain ?? auto;
    const player = new TakePlayer(app.rt().engine.ctx, take, gain);
    const timeEl = h('span', { class: 'time num' }, '0:00');
    const fill = h('i', { class: 'prog-fill' });
    const prog = h('div', { class: 'prog seekable', role: 'slider', 'aria-label': 'Position', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(take.duration)), 'aria-valuenow': '0', tabindex: '0' }, fill);
    const playBtn = h('button', { class: 'btn primary icon-lg', 'aria-label': 'Play', onclick: () => void toggle() }, icon('play2'));
    const toggle = async () => {
      if (player.playing) player.pause();
      else await player.play();
      renderPlay();
    };
    const renderPlay = () => {
      playBtn.replaceChildren(icon(player.playing ? 'pause' : 'play2'));
      playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    };
    player.onEnded = renderPlay;
    const seekTo = (e: PointerEvent) => {
      const r = prog.getBoundingClientRect();
      player.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * player.duration);
    };
    prog.addEventListener('pointerdown', (e) => {
      seekTo(e);
      const move = (ev: PointerEvent) => seekTo(ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    const gainVal = h('span', { class: 'val' }, `${Math.round(gain * 100)}%`);
    let saveTimer = 0;
    const gainSlider = slider({
      min: 0,
      max: 6,
      step: 0.1,
      value: gain,
      ariaLabel: 'Voice level',
      onInput: (v) => {
        gain = v;
        gainVal.textContent = `${Math.round(v * 100)}%`;
        player.setVocalGain(v);
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void updateTake(id, { vocalGain: v }).then((m) => m && (meta = m)), 400);
      },
    });

    const msg = h('div', { class: 'notice', style: 'display:none' });
    const say = (kind: '' | 'good' | 'bad', text: string) => {
      msg.className = `notice ${kind}`;
      msg.textContent = text;
      msg.style.display = text ? '' : 'none';
    };
    const files = () => {
      const base = fileBase(meta!);
      const out: { name: string; blob: Blob; label: string }[] = [];
      if (take.music) out.push({ name: `${base}-mix.wav`, blob: wavBlob(mixTake(take.mic, take.music, take.musicChannels, gain), take.musicChannels, take.sampleRate), label: 'Download mix (WAV)' });
      out.push({ name: `${base}-voice.wav`, blob: wavBlob(take.mic, 1, take.sampleRate), label: 'Download voice (WAV)' });
      return out;
    };
    const shareable = typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(44)], 'x.wav', { type: 'audio/wav' })] });
    const downloads = h(
      'div',
      { class: 'row', style: 'flex-wrap:wrap' },
      ...(take.music ? ['mix', 'voice'] : ['voice']).map((kind) =>
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              const f = files().find((x) => x.name.endsWith(`-${kind}.wav`))!;
              downloadBlob(f.name, f.blob);
            },
          },
          kind === 'mix' ? 'Download mix (WAV)' : 'Download voice (WAV)',
        ),
      ),
      shareable
        ? h(
            'button',
            {
              class: 'btn ghost',
              onclick: async () => {
                const f = files()[0]!;
                try {
                  await navigator.share({ files: [new File([f.blob], f.name, { type: 'audio/wav' })], title: meta!.name });
                } catch (e) {
                  if ((e as Error).name !== 'AbortError') say('bad', `Could not share: ${(e as Error).message}`);
                }
              },
            },
            'Share…',
          )
        : null,
    );

    const nameIn = h('input', { class: 'input', type: 'text', value: meta.name, 'aria-label': 'Recording name', maxlength: 120, style: 'min-width:220px' });
    nameIn.addEventListener('change', async () => {
      const name = nameIn.value.trim();
      if (!name) return;
      meta = (await updateTake(id, { name })) ?? meta;
      titleEl.textContent = name;
    });

    const chips = h(
      'div',
      { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
      h('span', { class: 'chip' }, MODE_LABEL[meta.mode]),
      meta.songTitle ? h('span', { class: 'chip' }, meta.songTitle) : null,
      h('span', { class: 'chip' }, fmtTime(meta.duration)),
      speedsLabel(meta) ? h('span', { class: 'chip' }, speedsLabel(meta)!) : null,
      meta.result ? h('span', { class: 'chip' }, `${meta.result.grade} · ${meta.result.score} points · ${meta.result.accuracy}% pitch`) : null,
      take.music ? h('span', { class: 'chip', title: 'Removed when lining your voice up with the music' }, `latency ${Math.round(meta.latency * 1000)} ms`) : null,
    );

    const parts: (HTMLElement | null)[] = [
      chips,
      h('div', { class: 'take-stage' }, canvas),
      h('div', { class: 'transport-row take-transport' }, playBtn, timeEl, prog, h('span', { class: 'time num faint' }, fmtTime(player.duration))),
      take.music
        ? h(
            'div',
            { class: 'row voice-level' },
            h('span', { class: 'field-label' }, 'Voice level'),
            gainSlider,
            gainVal,
            h('button', { class: 'btn ghost small', onclick: () => { gainSlider.value = String(auto); gainSlider.dispatchEvent(new Event('input')); } }, `Auto (${Math.round(auto * 100)}%)`),
          )
        : null,
      melody || !meta.songId ? null : h('p', { class: 'faint small', style: 'margin:0' }, 'The song of this recording is not in this browser, so its target melody cannot be drawn.'),
      h('div', { class: 'card stack' }, downloads, h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('span', { class: 'field-label' }, 'Name'), nameIn, h('div', { class: 'grow' }), h('button', { class: 'btn danger', onclick: async () => { if (await confirmDelete(meta!)) app.go({ name: 'recordings' }); } }, 'Delete')), msg),
      h('p', { class: 'faint tiny', style: 'margin:0' }, 'The mix is your voice over the music exactly as you heard it, at the speed and with the loops you used, lined up by removing the round-trip latency the scorer removes. The voice file is the microphone alone.'),
    ];
    body.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = player.time;
      drawFrame(t);
      timeEl.textContent = fmtTime(t);
      fill.style.width = `${(player.duration ? t / player.duration : 0) * 100}%`;
      prog.setAttribute('aria-valuenow', String(Math.round(t)));
    };
    raf = requestAnimationFrame(loop);
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        void toggle();
      } else if (e.key === 'ArrowLeft') player.seek(player.time - 5);
      else if (e.key === 'ArrowRight') player.seek(player.time + 5);
    };
    window.addEventListener('keydown', onKey);
    cleanup = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      player.destroy();
    };
  })();

  return {
    el,
    destroy: () => {
      destroyed = true;
      cleanup();
    },
  };
}
