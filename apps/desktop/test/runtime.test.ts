import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISABLED_CHROMIUM_FEATURES, demoChosen, demoDataDir, launchOptions, mergeDisabledFeatures, resourcePaths, withDemoChoice } from '../src/runtime.js';

test('packaged launch defaults to local, supports mock and attach, and never combines them', () => {
  assert.deepEqual(launchOptions([], {}, '/data/Nightshift'), { mode: 'local', dataDir: '/data/Nightshift', canSwitchDemo: true });
  assert.equal(launchOptions(['--mock'], {}, '/data').mode, 'mock');
  assert.equal(launchOptions([], { NIGHTSHIFT_MOCK: '1' }, '/data').mode, 'mock');
  assert.deepEqual(launchOptions(['--comfy-base-url', 'http://127.0.0.1:8191/'], {}, '/data'), { mode: 'attach', dataDir: '/data', canSwitchDemo: false, comfyBaseUrl: 'http://127.0.0.1:8191' });
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

test('the demo the user chose opens in mock mode on its own data folder beside the real one', () => {
  const real = launchOptions([], {}, '/Users/me/Library/Application Support/Nightshift');
  assert.equal(demoDataDir(real.dataDir), '/Users/me/Library/Application Support/Nightshift Demo');
  assert.deepEqual(withDemoChoice(real, true), { mode: 'mock', dataDir: '/Users/me/Library/Application Support/Nightshift Demo', canSwitchDemo: true });
  assert.deepEqual(withDemoChoice(real, false), real);
  // --data-dir alone still lets the app switch, and the demo sits beside that folder.
  assert.equal(withDemoChoice(launchOptions(['--data-dir', '/tmp/judge/'], {}, '/data'), true).dataDir, '/tmp/judge Demo');
});

test('switches at launch win over the demo choice, and the app then offers no switch', () => {
  for (const opened of [launchOptions(['--mock'], {}, '/data'), launchOptions([], { NIGHTSHIFT_MOCK: '1' }, '/data'), launchOptions(['--comfy-base-url=http://127.0.0.1:8191'], {}, '/data'), launchOptions([], { NIGHTSHIFT_COMFY_BASE_URL: 'http://127.0.0.1:8191' }, '/data')]) {
    assert.equal(opened.canSwitchDemo, false);
    assert.deepEqual(withDemoChoice(opened, true), opened);
  }
});

test('only an explicit yes in the choice file is the demo', () => {
  assert.equal(demoChosen('{"demo":true}'), true);
  for (const raw of [undefined, '', '{"demo":false}', '{"demo":"yes"}', 'not json', '[]']) assert.equal(demoChosen(raw), false);
});
