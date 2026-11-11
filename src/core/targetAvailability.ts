import type { MelodyNote } from './melody';

/** Match the ScoreEngine's default boundary tolerance, in song seconds at Sing speed. */
export const TARGET_WINDOW_TOLERANCE_SECONDS = 0.1;
export const TARGET_FREE_DELAY_SECONDS = 0.75;

interface TargetWindow {
  start: number;
  end: number;
}

/**
 * Playback-only feedback. Neither microphone voicing nor judgments affect target availability.
 * Transport changes must reset the delay so seeking into a long gap never announces it early.
 */
export class TargetAvailability {
  private readonly windows: TargetWindow[] = [];
  private outsideSince: number | null = null;
  private previousTime: number | null = null;

  constructor(notes: readonly Pick<MelodyNote, 't' | 'd'>[]) {
    const expanded = notes
      .filter((n) => Number.isFinite(n.t) && Number.isFinite(n.d) && n.d > 0)
      .map((n) => ({ start: n.t - TARGET_WINDOW_TOLERANCE_SECONDS, end: n.t + n.d + TARGET_WINDOW_TOLERANCE_SECONDS }))
      .sort((a, b) => a.start - b.start);
    for (const window of expanded) {
      const previous = this.windows[this.windows.length - 1];
      if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
      else this.windows.push(window);
    }
  }

  reset(): void {
    this.outsideSince = null;
    this.previousTime = null;
  }

  /** Closed display boundaries conservatively retain target status at exactly ±100 ms. */
  hasTargetAt(songTime: number): boolean {
    return this.windows.some((window) => songTime >= window.start && songTime <= window.end);
  }

  /** True only after continuously playing outside all eligible windows for the delay. */
  update(songTime: number, playing: boolean): boolean {
    if (!playing || !Number.isFinite(songTime)) {
      this.reset();
      return false;
    }
    if (this.previousTime !== null && songTime < this.previousTime) this.reset();
    const previousTime = this.previousTime;
    this.previousTime = songTime;
    if (this.hasTargetAt(songTime)) {
      this.outsideSince = null;
      return false;
    }
    if (this.outsideSince === null) this.outsideSince = songTime;
    // A rendering stall may skip a short target entirely. Its window still interrupts the
    // target-free passage, even when neither sampled endpoint falls inside that window.
    if (previousTime !== null) {
      for (const window of this.windows) {
        if (window.end >= previousTime && window.end < songTime) this.outsideSince = window.end;
      }
    }
    return songTime - this.outsideSince >= TARGET_FREE_DELAY_SECONDS;
  }
}
