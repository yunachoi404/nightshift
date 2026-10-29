import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISABLED_CHROMIUM_FEATURES, launchOptions, mergeDisabledFeatures, resourcePaths } from '../src/runtime.js';

test('packaged launch defaults to local, supports mock and attach, and never combines them', () => {
  assert.deepEqual(launchOptions([], {}, '/data/Nightshift'), { mode: 'local', dataDir: '/data/Nightshift' });
  assert.equal(launchOptions(['--mock'], {}, '/data').mode, 'mock');
  assert.equal(launchOptions([], { NIGHTSHIFT_MOCK: '1' }, '/data').mode, 'mock');
  assert.deepEqual(launchOptions(['--comfy-base-url', 'http://127.0.0.1:8191/'], {}, '/data'), { mode: 'attach', dataDir: '/data', comfyBaseUrl: 'http://127.0.0.1:8191' });
  assert.equal(launchOptions(['--data-dir=/demo'], {}, '/data').dataDir, '/demo');
  assert.throws(() => launchOptions(['--mock', '--comfy-base-url=http://localhost'], {}, '/data'));
  assert.throws(() => launchOptions(['--comfy-base-url'], {}, '/data'));
  assert.throws(() => launchOptions(['--comfy-base-url=file:///tmp/proxy'], {}, '/data'));
  assert.throws(() => launchOptions(['--comfy-base-url=https://user:secret@example.com'], {}, '/data'));
});

test('all engine resources resolve inside the supplied packaged runtime', () => {
  assert.deepEqual(resourcePaths('/Applications/Nightshift.app/Contents/Resources/runtime'), {
    entry: '/Applications/Nightshift.app/Contents/Resources/runtime/packages/engine/dist/engine.mjs',
    webDir: '/Applications/Nightshift.app/Contents/Resources/runtime/web',
    recipesDir: '/Applications/Nightshift.app/Contents/Resources/runtime/recipes',
    workflowsDir: '/Applications/Nightshift.app/Contents/Resources/runtime/workflows',
    nodesDir: '/Applications/Nightshift.app/Contents/Resources/runtime/comfy_nodes',
  });
});

test('the shell disables media session and hardware media keys, keeping any features already disabled', () => {
  assert.deepEqual(DISABLED_CHROMIUM_FEATURES, ['HardwareMediaKeyHandling', 'MediaSessionService']);
  assert.equal(mergeDisabledFeatures(undefined), 'HardwareMediaKeyHandling,MediaSessionService');
  assert.equal(mergeDisabledFeatures(''), 'HardwareMediaKeyHandling,MediaSessionService');
  // Electron sets its own list; ours is added to it, never replacing it.
  assert.equal(mergeDisabledFeatures('SpareRendererForSitePerProcess,TraceSiteInstanceGetProcessCreation'), 'SpareRendererForSitePerProcess,TraceSiteInstanceGetProcessCreation,HardwareMediaKeyHandling,MediaSessionService');
  // Already there: listed once.
  assert.equal(mergeDisabledFeatures(' MediaSessionService ,Other'), 'MediaSessionService,Other,HardwareMediaKeyHandling');
});
