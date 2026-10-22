const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mainHarness} = require('./main-harness.cjs');

test('new profiles and files without an opacity setting default to thirty percent',()=>{
  const h=mainHarness();
  assert.equal(h.api.settings().opacity,0.3);
  assert.equal(h.api.reloadSettings().opacity,0.3);
  h.files.set('/test/settings.json',JSON.stringify({topmost:false}));
  assert.equal(h.api.reloadSettings().opacity,0.3);
});

test('a failed write reports failure and leaves live settings unchanged', () => {
  const h=mainHarness({writeError:true});
  const before=JSON.stringify(h.api.settings());
  const result=h.save({...h.api.settings(),opacity:0.5,topmost:false});
  assert.equal(result.ok,false);
  assert.match(result.error,/read-only/);
  assert.equal(JSON.stringify(h.api.settings()),before);
});
test('a successful save persists the same settings shown in the app', () => {
  const h=mainHarness();
  const result=h.save({...h.api.settings(),opacity:0.6,topmost:false});
  assert.equal(result.ok,true);
  assert.equal(JSON.parse(h.files.get('/test/settings.json')).opacity,0.6);
  assert.equal(h.api.settings().opacity,0.6);
});

test('zero background opacity survives saving and reloading', () => {
  const h=mainHarness();
  const result=h.save({...h.api.settings(),opacity:0});
  assert.equal(result.ok,true);
  assert.equal(JSON.parse(h.files.get('/test/settings.json')).opacity,0);
  assert.equal(h.api.settings().opacity,0);
  assert.equal(h.api.reloadSettings().opacity,0);
});

test('existing background opacity values retain their stored value', () => {
  const h=mainHarness();
  for (const opacity of [0,0.3,0.4,0.5,1]) {
    h.files.set('/test/settings.json',JSON.stringify({...h.api.settings(),opacity}));
    assert.equal(h.api.reloadSettings().opacity,opacity);
  }
});
test('an invalid gateway is rejected without changing the live address', () => {
  const h=mainHarness();const before=JSON.stringify(h.api.settings());
  const result=h.save({...h.api.settings(),gateway:'this is not an address'});
  assert.equal(result.ok,false);assert.equal(JSON.stringify(h.api.settings()),before);
});
