/**
 * Local-only persistence. Everything is small JSON, so localStorage is the right tool; all
 * access is wrapped so private windows or blocked storage degrade to in-memory state. Song
 * files live in IndexedDB (core/idb.ts, core/songpack.ts).
 */

export type Speed = 0.5 | 0.75 | 1;
export const SPEEDS: Speed[] = [0.5, 0.75, 1];

export interface Settings {
  deviceId: string | null;
  headphones: boolean;
  /** Level gate in dBFS: quieter frames count as silence. */
  gateDb: number;
  /** Music (instrumental / reference) volume 0..1. */
  musicVol: number;
  monitoring: boolean;
  monitorVol: number;
  /** Calibrated round-trip latency in ms, or null to use the browser's estimate. */
  latencyMs: number | null;
  foldOctaves: boolean;
  showNoteNames: boolean;
  /** Preferred practice speed. */
  speed: Speed;
  /** Reference vocal on by default when entering a session. */
  referenceVocal: boolean;
}

export interface AttemptRecord {
  date: number;
  score: number;
  accuracy: number;
  timing: number;
  grade: string;
  bestStreak: number;
  mode: 'sing' | 'practice';
  speed: number;
}

export interface SongProgress {
  best: AttemptRecord | null;
  attempts: AttemptRecord[];
  plays: number;
}

export interface SaveData {
  version: 2;
  settings: Settings;
  progress: Record<string, SongProgress>;
  /** Last playback position per song (s), for "resume where you left off". */
  lastPosition: Record<string, number>;
}

export const DEFAULT_SETTINGS: Settings = {
  deviceId: null,
  headphones: true,
  gateDb: -48,
  musicVol: 0.8,
  monitoring: false,
  monitorVol: 0.5,
  latencyMs: null,
  foldOctaves: true,
  showNoteNames: false,
  speed: 1,
  referenceVocal: false,
};

const KEY = 'pitchhero:v2';
const LEGACY_KEYS = ['pitchline:v1', 'pitchline:imports:v1'];
export const WARMUP_SESSION_KEY = 'pitchhero:warmupOffered';

function emptySave(): SaveData {
  return { version: 2, settings: { ...DEFAULT_SETTINGS }, progress: {}, lastPosition: {} };
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isSpeed(v: unknown): v is Speed {
  return v === 0.5 || v === 0.75 || v === 1;
}

/** Carry microphone, latency and display settings over from the Pitchline save. */
function migrateLegacy(): Partial<Settings> | null {
  const old = readJSON<{ version?: number; settings?: Record<string, unknown> }>('pitchline:v1');
  if (!old || old.version !== 1 || !old.settings) return null;
  const s = old.settings;
  const out: Partial<Settings> = {};
  if (typeof s.deviceId === 'string' || s.deviceId === null) out.deviceId = s.deviceId as string | null;
  if (typeof s.headphones === 'boolean') out.headphones = s.headphones;
  if (typeof s.gateDb === 'number') out.gateDb = s.gateDb;
  if (typeof s.backingVol === 'number') out.musicVol = s.backingVol;
  if (typeof s.monitoring === 'boolean') out.monitoring = s.monitoring;
  if (typeof s.monitorVol === 'number') out.monitorVol = s.monitorVol;
  if (typeof s.latencyMs === 'number' || s.latencyMs === null) out.latencyMs = s.latencyMs as number | null;
  if (typeof s.foldOctaves === 'boolean') out.foldOctaves = s.foldOctaves;
  if (typeof s.showNoteNames === 'boolean') out.showNoteNames = s.showNoteNames;
  return out;
}

export class Store {
  data: SaveData;
  private listeners = new Set<() => void>();

  constructor() {
    const loaded = readJSON<Partial<SaveData>>(KEY);
    const base = emptySave();
    if (loaded && loaded.version === 2) {
      const settings = { ...DEFAULT_SETTINGS, ...(loaded.settings ?? {}) };
      if (!isSpeed(settings.speed)) settings.speed = 1;
      this.data = { ...base, ...loaded, settings, progress: loaded.progress ?? {}, lastPosition: loaded.lastPosition ?? {} };
    } else {
      const legacy = migrateLegacy();
      this.data = legacy ? { ...base, settings: { ...DEFAULT_SETTINGS, ...legacy } } : base;
      if (legacy) {
        this.save();
        for (const k of LEGACY_KEYS) {
          try {
            localStorage.removeItem(k);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  progress(songId: string): SongProgress {
    return this.data.progress[songId] ?? { best: null, attempts: [], plays: 0 };
  }

  /** Records an attempt; returns the previous best for "new best" messaging. */
  recordAttempt(songId: string, a: AttemptRecord): { previousBest: AttemptRecord | null; isNewBest: boolean } {
    const p = this.progress(songId);
    const previousBest = p.best;
    const counts = a.mode === 'sing' && a.speed === 1;
    const isNewBest = counts && (!previousBest || a.score > previousBest.score);
    this.data.progress[songId] = {
      plays: p.plays + 1,
      best: isNewBest ? a : previousBest,
      attempts: [...p.attempts, a].slice(-30),
    };
    this.save();
    return { previousBest, isNewBest };
  }

  lastPosition(songId: string): number {
    return this.data.lastPosition[songId] ?? 0;
  }

  setLastPosition(songId: string, seconds: number): void {
    const v = Math.max(0, Math.round(seconds * 10) / 10);
    if (this.data.lastPosition[songId] === v) return;
    this.data.lastPosition[songId] = v;
    writeJSON(KEY, this.data); // frequent: skip listeners
  }

  resetAll(): void {
    this.data = emptySave();
    this.save();
    try {
      sessionStorage.removeItem(WARMUP_SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private save(): void {
    writeJSON(KEY, this.data);
    for (const l of this.listeners) l();
  }
}

/** Warm-up offer: once per browser session (a tab), not once per song start. */
export function warmupOffered(): boolean {
  try {
    return sessionStorage.getItem(WARMUP_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function markWarmupOffered(): void {
  try {
    sessionStorage.setItem(WARMUP_SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
}
