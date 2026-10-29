import { EventSchema, JobSchema } from '@nightshift/contract';
import type { Event } from '@nightshift/contract';
import type { JobTracker } from './jobs.js';

/** SSE accepts both named `job` frames and ordinary `message` frames. */
export class SseParser {
  private pending = '';
  private data: string[] = [];
  constructor(private receive: (value: unknown) => void) {}
  push(chunk: string): void {
    this.pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\r|\n/.exec(this.pending))) {
      // A CR at a chunk boundary may be the first half of CRLF.
      if (match[0] === '\r' && match.index === this.pending.length - 1) break;
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) {
          try { this.receive(JSON.parse(this.data.join('\n'))); } catch { /* Ignore malformed frame. */ }
          this.data = [];
        }
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (this.pending.length > 1_000_000 || this.data.join('').length > 1_000_000) throw new Error('SSE frame too large');
  }
}

export async function watchJobs(url: string, tracker: JobTracker, signal: AbortSignal, connection: (connected: boolean) => void): Promise<void> {
  let delay = 500;
  while (!signal.aborted) {
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    signal.addEventListener('abort', abort, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => attempt.abort(), 45_000);
      };
      arm();
      const response = await fetch(`${url}/api/events`, { signal: attempt.signal, headers: { Accept: 'text/event-stream' } });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('SSE unavailable');
      let buffered: Event[] | undefined = [];
      const parser = new SseParser(value => {
        const event = EventSchema.safeParse(value);
        if (!event.success) return;
        if (buffered) buffered.push(event.data);
        else if (event.data.type === 'job') tracker.event(event.data.job);
      });
      const reader = response.body.getReader();
      const stream = (async () => {
        const decoder = new TextDecoder();
        while (!attempt.signal.aborted) {
          const part = await reader.read();
          if (part.done) throw new Error('SSE ended');
          arm();
          parser.push(decoder.decode(part.value, { stream: true }));
        }
      })();
      // Attach rejection immediately while the snapshot request is still in flight.
      void stream.catch(() => attempt.abort());
      const snapshot = await fetch(`${url}/api/jobs`, { signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10_000)]) });
      if (!snapshot.ok) throw new Error('Queue unavailable');
      tracker.snapshot(JobSchema.array().parse(await snapshot.json()));
      for (const event of buffered) if (event.type === 'job') tracker.event(event.job);
      buffered = undefined;
      connection(true);
      delay = 500;
      await stream;
    } catch {
      connection(false);
      // Preserve the sleep assertion until a new snapshot proves the queue is idle.
    } finally {
      attempt.abort();
      clearTimeout(watchdog);
      signal.removeEventListener('abort', abort);
    }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, delay);
      signal.addEventListener('abort', done, { once: true });
    });
    delay = Math.min(delay * 2, 10_000);
  }
}
