import { MicError } from '../audio/mic';
import { getRuntime, hasRuntime, type VoiceRuntime } from '../audio/voice';
import { LIBRARY } from '../core/library';
import { chooseTransposition } from '../core/range';
import type { Song } from '../core/song';
import { Store } from '../core/storage';
import { clear } from './dom';

export type Route =
  | { name: 'home' }
  | { name: 'setup'; next?: Route }
  | { name: 'range'; next?: Route }
  | { name: 'latency'; next?: Route }
  | { name: 'songs'; selectId?: string }
  | { name: 'play'; config: PlayConfig }
  | { name: 'results'; result: import('./screens/results').AttemptResult }
  | { name: 'trainer' }
  | { name: 'settings' };

export interface PlayConfig {
  songId: string;
  mode: 'sing' | 'practice';
  speed: number;
  /** Section index for practice, or null for the whole song. */
  section: number | null;
  loop: boolean;
  guide: boolean;
  backing: boolean;
  /** Semitones from the written key. */
  transpose: number;
  /** When set, replays a recorded voice trail instead of listening. */
  replay?: import('./screens/results').ReplayData;
}

export interface Screen {
  el: HTMLElement;
  destroy?: () => void;
}

export type ScreenFactory = (app: App, route: Route) => Screen;

export class App {
  readonly store = new Store();
  private readonly root: HTMLElement;
  private current: Screen | null = null;
  private readonly factories = new Map<Route['name'], ScreenFactory>();
  private imported: Song[];
  route: Route = { name: 'home' };

  constructor(root: HTMLElement) {
    this.root = root;
    this.imported = this.store.loadImports();
  }

  register(name: Route['name'], f: ScreenFactory): void {
    this.factories.set(name, f);
  }

  go(route: Route): void {
    this.current?.destroy?.();
    clear(this.root);
    this.route = route;
    const f = this.factories.get(route.name);
    if (!f) throw new Error(`No screen ${route.name}`);
    this.current = f(this, route);
    this.root.appendChild(this.current.el);
    window.scrollTo(0, 0);
  }

  songs(): Song[] {
    return [...LIBRARY, ...this.imported];
  }

  songById(id: string): Song | undefined {
    return this.songs().find((s) => s.id === id);
  }

  addImported(song: Song): boolean {
    this.imported = [...this.imported.filter((s) => s.id !== song.id), song];
    return this.store.saveImports(this.imported);
  }

  removeImported(id: string): void {
    this.imported = this.imported.filter((s) => s.id !== id);
    this.store.saveImports(this.imported);
  }

  /** Lazily creates the audio runtime (must be called from a user gesture the first time). */
  rt(): VoiceRuntime {
    const fresh = !hasRuntime();
    const rt = getRuntime();
    if (fresh) this.applyAudioSettings();
    return rt;
  }

  get micReady(): boolean {
    return hasRuntime() && getRuntime().mic.isOpen;
  }

  applyAudioSettings(): void {
    if (!hasRuntime()) return;
    const s = this.store.settings;
    const rt = getRuntime();
    rt.engine.setVolumes({ backing: s.backingVol, melody: s.melodyVol, click: s.clickVol });
    rt.setGate(s.gateDb);
    rt.mic.setMonitoring(s.monitoring && s.headphones, s.monitorVol);
  }

  /** Opens the mic with saved settings. Returns an error message or null on success. */
  async openMic(deviceId?: string | null): Promise<string | null> {
    const s = this.store.settings;
    try {
      const rt = this.rt();
      await rt.openMic({ deviceId: deviceId === undefined ? s.deviceId : deviceId, echoCancellation: !s.headphones });
      this.applyAudioSettings();
      const id = rt.mic.deviceId;
      if (id && id !== s.deviceId) this.store.updateSettings({ deviceId: id });
      return null;
    } catch (e) {
      return e instanceof MicError ? e.message : `Could not start audio: ${(e as Error).message}`;
    }
  }

  /** Round-trip latency to compensate (s). */
  latency(): number {
    const ms = this.store.settings.latencyMs;
    if (ms !== null) return ms / 1000;
    if (!hasRuntime()) return 0.08;
    const rt = getRuntime();
    return rt.engine.defaultLatency(rt.mic.inputLatency);
  }

  /** Transposition for a song: user override, else fit to the saved range, else written key. */
  transposeFor(song: Song): { semitones: number; auto: number; override: boolean } {
    const range = this.store.data.range;
    const auto = range ? chooseTransposition(song, range).semitones : 0;
    const o = this.store.progress(song.id).transpose;
    return o === null ? { semitones: auto, auto, override: false } : { semitones: o, auto, override: true };
  }

  /**
   * Starts a song, routing through mic setup and the range check first if needed, so the
   * acceptance path (pick song, allow mic, start) works without visiting setup screens.
   */
  startSong(config: PlayConfig): void {
    const route: Route = { name: 'play', config };
    const needsRange = !this.store.data.range && !this.store.data.onboarded;
    // After a first range check, return to the song so the new key is visible before singing.
    const afterRange: Route = { name: 'songs', selectId: config.songId };
    if (!this.micReady) {
      this.go({ name: 'setup', next: needsRange ? { name: 'range', next: afterRange } : route });
      return;
    }
    if (needsRange) {
      this.go({ name: 'range', next: afterRange });
      return;
    }
    this.go(route);
  }
}
