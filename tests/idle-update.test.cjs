const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mainHarness} = require('./main-harness.cjs');

test('usage polling does not postpone an idle update', async () => {
  const h=mainHarness(); h.api.prepareUpdate();h.api.schedule();
  for(let i=0;i<15;i++){await h.api.usage();h.tick(20000);}
  assert.equal(h.installed,1);
});
test('a long-running request blocks idle installation', () => {
  const h=mainHarness();h.api.prepareUpdate();h.api.setTrace([{done:false}]);h.api.schedule();
  h.tick(600000);assert.equal(h.installed,0);
});
test('switching to notice cancels automatic installation', () => {
  const h=mainHarness();h.api.prepareUpdate();h.api.schedule();h.api.changeMode('notice');
  h.tick(600000);assert.equal(h.installed,0);
});
