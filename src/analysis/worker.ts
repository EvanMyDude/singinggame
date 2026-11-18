import { analyzeSong, type AnalysisInput } from './prepare';

/**
 * Runs the song analysis off the main thread. One message in (the decoded stems), progress
 * messages out, then the melody document and its report, or an error.
 */

export type WorkerRequest = AnalysisInput;

export type WorkerReply =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'done'; doc: ReturnType<typeof analyzeSong>['doc']; report: ReturnType<typeof analyzeSong>['report'] }
  | { type: 'error'; message: string };

// Typed by hand: the project compiles against the DOM library, not the worker one.
const scope = self as unknown as { postMessage(m: WorkerReply): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const post = (m: WorkerReply) => scope.postMessage(m);
  try {
    let last = -1;
    const { doc, report } = analyzeSong(e.data, (stage, fraction) => {
      // Throttle to whole percents; the pitch tracker reports often.
      const pct = Math.floor(fraction * 100);
      if (pct !== last) {
        last = pct;
        post({ type: 'progress', stage, fraction });
      }
    });
    post({ type: 'done', doc, report });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
