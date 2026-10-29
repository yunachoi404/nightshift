import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobTracker } from '../src/jobs.js';
import { SseParser } from '../src/events.js';
import { containedPath, externalUrl, safeId } from '../src/paths.js';
import type { Job } from '@nightshift/contract';

const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({ id: 'one', projectId: 'project', mode: 'overnight', step: 'video_final_same_take', status, progress: status === 'done' ? 1 : 0, outputAssetIds: [], createdAt: '2026-10-19T00:00:00Z', ...extra });

test('overnight lifecycle holds awake through queued/running and notifies once per final', () => {
  const notifications: Job[] = [];
  let active = 0;
  const tracker = new JobTracker(j => notifications.push(j), count => { active = count; });
  tracker.snapshot([job('done', { id: 'historical' })]);
  assert.equal(notifications.length, 0);
  tracker.event(job('queued'));
  assert.equal(active, 1);
  tracker.event(job('running'));
  tracker.event(job('done'));
  tracker.event(job('done'));
  tracker.snapshot([job('done')]);
  assert.equal(active, 0);
  assert.equal(notifications.length, 1);
  tracker.event(job('failed', { id: 'two' }));
  assert.equal(notifications.length, 2);
  tracker.event(job('done', { id: 'interactive', mode: 'now' }));
  tracker.event(job('done', { id: 'audio', step: 'voice' }));
  assert.equal(notifications.length, 2);
});

test('reconnect detects an offline completion without replaying history and drops removed jobs', () => {
  const notifications: Job[] = [];
  const tracker = new JobTracker(j => notifications.push(j), () => {});
  tracker.snapshot([job('running')]);
  tracker.snapshot([job('failed'), job('done', { id: 'old' })]);
  assert.deepEqual(notifications.map(j => j.status), ['failed']);
  tracker.event(job('queued', { id: 'removed' }));
  tracker.snapshot([]);
  assert.equal(tracker.activeCount, 0);
});

test('snapshot terminal state cannot regress when older SSE frames were buffered', () => {
  const notifications: Job[] = [];
  const tracker = new JobTracker(j => notifications.push(j), () => {});
  tracker.snapshot([job('done')]);
  tracker.event(job('queued'));
  tracker.event(job('running'));
  tracker.event(job('done'));
  assert.equal(tracker.activeCount, 0);
  assert.equal(notifications.length, 0);
});

test('SSE handles CRLF boundaries, multiline JSON, comments and malformed frames', () => {
  const values: unknown[] = [];
  const parser = new SseParser(value => values.push(value));
  parser.push(': heartbeat\r');
  parser.push('\nevent: job\r\ndata: {"type":\r\ndata: "job"}\r\n\r');
  parser.push('\ndata: invalid\n\ndata: {"ok":true}\n\n');
  assert.deepEqual(values, [{ type: 'job' }, { ok: true }]);
});

test('Finder rejects traversal and symlink escapes; external links reject executable protocols', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightshift-desktop-'));
  try {
    await mkdir(join(root, 'project'));
    await writeFile(join(root, 'project', 'export.mp4'), 'placeholder');
    await writeFile(join(root, 'private'), 'outside');
    await symlink(join(root, 'private'), join(root, 'project', 'link'));
    assert.equal(await containedPath(join(root, 'project'), 'export.mp4'), await import('node:fs/promises').then(fs => fs.realpath(join(root, 'project', 'export.mp4'))));
    await assert.rejects(containedPath(join(root, 'project'), '../private'));
    await assert.rejects(containedPath(join(root, 'project'), 'link'));
    assert.throws(() => externalUrl('file:///etc/passwd'));
    assert.throws(() => externalUrl('javascript:alert(1)'));
    assert.throws(() => externalUrl('https://user:password@example.com'));
    assert.throws(() => safeId('../private'));
    assert.equal(externalUrl('https://www.comfy.org/'), 'https://www.comfy.org/');
  } finally { await rm(root, { recursive: true, force: true }); }
});
