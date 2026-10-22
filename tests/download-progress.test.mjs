import {test} from 'node:test';
import assert from 'node:assert/strict';
import {downloadSize} from '../web/download-progress.mjs';
test('download bytes use a common readable unit',()=>{
  assert.equal(downloadSize(12.3*1024**2,53.8*1024**2).text,'12.3 MB / 53.8 MB');
  assert.equal(downloadSize(0,53.8*1024**2).compact,'0.0/53.8 MB');
});
test('unknown totals and invalid numbers remain explicit',()=>{
  assert.equal(downloadSize(1024,0).text,'1.0 KB / 未知大小');
  assert.equal(downloadSize(NaN,Infinity).text,'0 B / 未知大小');
});
