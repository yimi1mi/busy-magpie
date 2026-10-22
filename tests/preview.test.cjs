const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mainHarness}=require('./main-harness.cjs');
test('local previews use a distinct profile without changing login startup or installing updates',async()=>{
  const h=mainHarness({preview:true});
  assert.match(h.paths.get('userData').replaceAll('\\','/'),/\/test\/preview$/);
  h.api.autostart();await h.api.checkUpdates();h.api.prepareUpdate();await h.api.installUpdate();
  assert.equal(h.loginChanges,0);assert.equal(h.updateChecks,0);assert.equal(h.installed,0);
});
