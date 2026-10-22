const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

test('macOS applies a ready signed business package through the shell updater', async () => {
  const h = mainHarness({ platform: 'darwin' });
  h.api.prepareUpdate('business');
  await h.api.installUpdate();
  assert.equal(h.installed, 1);
  assert.deepEqual(h.openedUrls, []);
});

test('macOS runtime upgrades open the installer release without invoking a Windows install', async () => {
  const h = mainHarness({ platform: 'darwin' });
  h.api.prepareUpdate('shell');
  await h.api.installUpdate();
  assert.equal(h.installed, 0);
  assert.deepEqual(h.openedUrls, ['https://github.com/yimi1mi/busy-magpie/releases/tag/v1.4.0']);
});
