import { MicError } from '../audio/mic';
import type { TrackPlayer } from '../audio/trackPlayer';
import { getRuntime, hasRuntime, type VoiceRuntime } from '../audio/voice';
import { loadPack, type PackStatus, type SongPack } from '../core/songpack';
import { loadRegistry, type SongDef } from '../core/songs';
import { Store, markWarmupOffered, warmupOffered } from '../core/storage';
import { clear } from './dom';

export interface SessionConfig {
  mode: 'sing' | 'practice';
  /** Start position (s). */
  startAt?: number;
  /** Initial A–B loop (practice). */
  loop?: { a: number; b: number };
}

export type Route =
  | { name: 'home' }
  | { name: 'setup'; next?: Route }
  | { name: 'latency'; next?: Route }
  | { name: 'warmup'; next?: Route }
  | { name: 'sing'; config: SessionConfig }
  | { name: 'results'; result: import('./screens/results').AttemptResult }
  | { name: 'monitor' }
  | { name: 'settings' }
  | { name: 'sync' };

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
  /** The songs the app offers (songs/index.json); empty until the registry has loaded. */
  songs: SongDef[] = [];
  /** Problems found while loading the registry. */
  registryErrors: string[] = [];
  private registryPromise: Promise<void> | null = null;
  /** Files status of the current song; null until its first load finishes. */
  packStatus: PackStatus | null = null;
  private packPromise: Promise<PackStatus | null> | null = null;
  /** The track player of the screen currently playing the song (for automated checks). */
  activePlayer: TrackPlayer | null = null;
  route: Route = { name: 'home' };

  constructor(root: HTMLElement) {
    this.root = root;
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

  /** Loads the song list once. */
  loadRegistry(): Promise<void> {
    this.registryPromise ??= loadRegistry().then((r) => {
      this.songs = r.songs;
      this.registryErrors = r.errors;
    });
    return this.registryPromise;
  }

  /** The song being practiced: the one last chosen, else the first in the list. */
  get song(): SongDef | null {
    const id = this.store.currentSong;
    return this.songs.find((s) => s.id === id) ?? this.songs[0] ?? null;
  }

  /** Makes another song current; its files load on the next `loadPack`. */
  selectSong(id: string): void {
    if (!this.songs.some((s) => s.id === id) || this.song?.id === id) return;
    this.store.setCurrentSong(id);
    this.packStatus = null;
    this.packPromise = null;
  }

  /** Loads (or reloads after an import) the current song's files. Null when there is no song. */
  loadPack(force = false): Promise<PackStatus | null> {
    if (!this.packPromise || force) {
      const p: Promise<PackStatus | null> = this.loadRegistry().then(async () => {
        const song = this.song;
        if (!song) return null;
        const status = await loadPack(song, force);
        // Ignore a load that finished after the user moved to another song.
        if (this.packPromise === p) this.packStatus = status;
        return status;
      });
      this.packPromise = p;
    }
    return this.packPromise;
  }

  get pack(): SongPack | null {
    return this.packStatus?.pack ?? null;
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

  /**
   * Starts a Sing or Practice session: offers the warm-up once per browser session, then
   * routes through the mic check if the microphone is not open yet.
   */
  async startSession(config: SessionConfig): Promise<void> {
    const route: Route = { name: 'sing', config };
    if (!warmupOffered()) {
      markWarmupOffered();
      this.go({ name: 'warmup', next: route });
      return;
    }
    await this.continueTo(route);
  }

  /** Mic gate for a route that needs the microphone. */
  async continueTo(route: Route): Promise<void> {
    if (!this.micReady && (await micPermissionGranted())) await this.openMic();
    if (!this.micReady) {
      this.go({ name: 'setup', next: route });
      return;
    }
    this.go(route);
  }
}

/** True when the browser reports microphone permission as already granted (Chromium, Safari). */
async function micPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false; // Firefox does not expose this permission name.
  }
}
