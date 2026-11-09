/**
 * Clocks for a media-element-driven song.
 *
 * `SmoothClock` turns the stepped `currentTime` of an HTMLMediaElement into a smooth,
 * monotonic song time for rendering: it extrapolates from the last anchor at the playback
 * rate and slews gently toward each new reading, with a hard reset for seeks.
 *
 * `CtxClock` relates AudioContext time (what microphone frames are stamped with) to song time
 * for scoring. Pairs (ctxTime, songTime) are sampled together; the median of recent offsets
 * rejects the jitter of individual readings. Both are pure so they can be unit-tested.
 */

export class SmoothClock {
  private anchorT = 0;
  private anchorMs = 0;
  private rate = 1;
  private playing = false;
  private last = 0;
  private hasAnchor = false;

  reset(mediaTime: number, nowMs: number): void {
    this.anchorT = mediaTime;
    this.anchorMs = nowMs;
    this.last = mediaTime;
    this.hasAnchor = true;
  }

  setRate(rate: number, nowMs: number): void {
    if (this.hasAnchor) {
      this.anchorT = this.predict(nowMs);
      this.anchorMs = nowMs;
    }
    this.rate = rate;
  }

  setPlaying(playing: boolean, mediaTime: number, nowMs: number): void {
    this.playing = playing;
    this.reset(mediaTime, nowMs);
  }

  private predict(nowMs: number): number {
    if (!this.hasAnchor) return 0;
    if (!this.playing) return this.anchorT;
    return this.anchorT + ((nowMs - this.anchorMs) / 1000) * this.rate;
  }

  /** Feed a `currentTime` reading taken at `nowMs`. */
  sample(mediaTime: number, nowMs: number): void {
    if (!this.hasAnchor) {
      this.reset(mediaTime, nowMs);
      return;
    }
    const p = this.predict(nowMs);
    const err = mediaTime - p;
    if (Math.abs(err) > 0.25 || !this.playing) {
      this.reset(mediaTime, nowMs);
      return;
    }
    // Slew: a stepped reading that is slightly ahead/behind pulls the anchor part way.
    this.anchorT = p + err * 0.25;
    this.anchorMs = nowMs;
  }

  now(nowMs: number): number {
    const t = this.predict(nowMs);
    // Monotonic while playing; a seek goes through reset(), which may move backwards.
    if (this.playing && t < this.last && this.last - t < 0.08) return this.last;
    this.last = t;
    return t;
  }
}

export class CtxClock {
  private offsets: number[] = [];
  private rate = 1;
  private current: number | null = null;

  reset(): void {
    this.offsets = [];
    this.current = null;
  }

  setRate(rate: number): void {
    if (rate !== this.rate) {
      this.rate = rate;
      this.reset();
    }
  }

  /** A simultaneous reading of AudioContext time and song time while playing. */
  sample(ctxTime: number, songTime: number): void {
    this.offsets.push(songTime - this.rate * ctxTime);
    if (this.offsets.length > 9) this.offsets.shift();
    const s = [...this.offsets].sort((a, b) => a - b);
    const med = s[s.length >> 1]!;
    // Ignore tiny wander; re-anchor on anything larger (a seek, a stall, a real drift).
    if (this.current === null || Math.abs(med - this.current) > 0.02) this.current = med;
  }

  get ready(): boolean {
    return this.current !== null;
  }

  /** Song time at an AudioContext time; NaN until a sample exists. */
  songTimeAt(ctxTime: number): number {
    return this.current === null ? NaN : this.current + this.rate * ctxTime;
  }

  /** AudioContext time at which `songTime` sounds; NaN until a sample exists. */
  ctxTimeAt(songTime: number): number {
    return this.current === null ? NaN : (songTime - this.current) / this.rate;
  }
}
