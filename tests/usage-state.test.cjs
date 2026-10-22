const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mainHarness} = require('./main-harness.cjs');

test('a failed period switch keeps the successful snapshot and selected period',async()=>{
  const h=mainHarness();await h.api.usage();
  const before=JSON.stringify(h.api.usageData());
  h.setFetch(async()=>({ok:false,status:503}));
  assert.equal((await h.period('7d')).ok,false);
  assert.equal(h.api.settings().usagePeriod,'30d');
  assert.equal(JSON.stringify(h.api.usageData()),before);
  assert.equal(h.api.usageStatus().stale,true);
});
test('an old response cannot replace the newest requested period',async()=>{
  const h=mainHarness();let release;
  h.setFetch(()=>new Promise(resolve=>{release=resolve;}));
  const old=h.api.usage();
  h.setFetch(async()=>({ok:true,json:async()=>({input:7})}));
  assert.equal((await h.period('7d')).ok,true);
  release({ok:true,json:async()=>({input:30})});await old;
  assert.equal(h.api.usageData().input,7);
  assert.equal(h.api.usageData().period,'7d');
});
