import type { VocalRange } from './range';
import type { Song } from './song';

/**
 * Local-only persistence. Everything is small JSON, so localStorage is the right tool; all
 * access is wrapped so private windows or blocked storage degrade to in-memory state.
 */

export interface Settings {
  deviceId: string | null;
  headphones: boolean;
  /** Level gate in dBFS: quieter frames count as silence. */
  gateDb: number;
  backingVol: number;
  melodyVol: number;
  clickVol: number;
  monitoring: boolean;
  monitorVol: number;
  /** Calibrated round-trip latency in ms, or null to use the browser's estimate. */
  latencyMs: number | null;
  foldOctaves: boolean;
  showNoteNames: boolean;
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
  /** User override of the automatic transposition, in semitones from the written key. */
  transpose: number | null;
}

export interface TrainerBest {
  score: number;
  date: number;
}

export interface SaveData {
  version: 1;
  settings: Settings;
  range: VocalRange | null;
  rangeSource: 'measured' | 'preset' | null;
  onboarded: boolean;
  progress: Record<string, SongProgress>;
  trainer: Record<string, TrainerBest>;
}

export const DEFAULT_SETTINGS: Settings = {
  deviceId: null,
  headphones: true,
  gateDb: -48,
  backingVol: 0.7,
  melodyVol: 0.75,
  clickVol: 0.6,
  monitoring: false,
  monitorVol: 0.5,
  latencyMs: null,
  foldOctaves: true,
  showNoteNames: false,
};

const KEY = 'pitchline:v1';
const IMPORTS_KEY = 'pitchline:imports:v1';

function emptySave(): SaveData {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, range: null, rangeSource: null, onboarded: false, progress: {}, trainer: {} };
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

export class Store {
  data: SaveData;
  private listeners = new Set<() => void>();

  constructor() {
    const loaded = readJSON<Partial<SaveData>>(KEY);
    const base = emptySave();
    this.data = loaded && loaded.version === 1
      ? {
          ...base,
          ...loaded,
          settings: { ...DEFAULT_SETTINGS, ...(loaded.settings ?? {}) },
          progress: loaded.progress ?? {},
          trainer: loaded.trainer ?? {},
        }
      : base;
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  setRange(range: VocalRange | null, source: 'measured' | 'preset' | null): void {
    this.data.range = range;
    this.data.rangeSource = source;
    this.save();
  }

  setOnboarded(): void {
    this.data.onboarded = true;
    this.save();
  }

  progress(songId: string): SongProgress {
    return this.data.progress[songId] ?? { best: null, attempts: [], plays: 0, transpose: null };
  }

  setTransposeOverride(songId: string, semitones: number | null): void {
    const p = this.progress(songId);
    this.data.progress[songId] = { ...p, transpose: semitones };
    this.save();
  }

  /** Records an attempt; returns the previous best for "new best" messaging. */
  recordAttempt(songId: string, a: AttemptRecord): { previousBest: AttemptRecord | null; isNewBest: boolean } {
    const p = this.progress(songId);
    const previousBest = p.best;
    const counts = a.mode === 'sing' && a.speed === 1;
    const isNewBest = counts && (!previousBest || a.score > previousBest.score);
    this.data.progress[songId] = {
      ...p,
      plays: p.plays + 1,
      best: isNewBest ? a : previousBest,
      attempts: [...p.attempts, a].slice(-30),
    };
    this.save();
    return { previousBest, isNewBest };
  }

  recordTrainer(key: string, score: number): boolean {
    const prev = this.data.trainer[key];
    if (!prev || score > prev.score) {
      this.data.trainer[key] = { score, date: Date.now() };
      this.save();
      return true;
    }
    return false;
  }

  resetAll(): void {
    this.data = emptySave();
    this.save();
    try {
      localStorage.removeItem(IMPORTS_KEY);
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

  loadImports(): Song[] {
    return readJSON<Song[]>(IMPORTS_KEY) ?? [];
  }

  saveImports(songs: Song[]): boolean {
    return writeJSON(IMPORTS_KEY, songs);
  }
}
