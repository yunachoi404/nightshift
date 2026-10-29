import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { watchJobs } from '../src/events.js';
import { JobTracker } from '../src/jobs.js';
import type { Job } from '@nightshift/contract';

test('real SSE disconnect preserves awake state and resync notifies an offline completion', { timeout: 10_000 }, async () => {
  let streams = 0;
  let stream: ServerResponse | undefined;
  const active: number[] = [];
  const notices: Job[] = [];
  const connected: boolean[] = [];
  const abort = new AbortController();
  const job: Job = { id: 'offline-final', projectId: 'p', step: 'video_final_remaster', mode: 'overnight', status: 'running', progress: 0.5, outputAssetIds: [], createdAt: '2026-10-19T00:00:00Z' };
  const server = createServer((request, response) => {
    if (request.url === '/api/events') {
      streams++;
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': connected\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ ...job, status: streams === 1 ? 'running' : 'done', progress: streams === 1 ? 0.5 : 1 }]));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const tracker = new JobTracker(value => notices.push(value), count => active.push(count));
  try {
    await watchJobs(`http://127.0.0.1:${address.port}`, tracker, AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), value => {
      connected.push(value);
      if (value && streams === 1) stream?.end();
      if (!value && streams === 1) active.push(tracker.activeCount);
      if (value && streams === 2) abort.abort();
    });
    assert.equal(streams, 2);
    assert.deepEqual(active, [1, 1, 0]);
    assert.equal(connected.filter(Boolean).length, 2);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.status, 'done');
  } finally {
    abort.abort();
    stream?.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
