import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/presenter.js',import.meta.url),'utf8');
const {present}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const text=parts=>parts.map(p=>p.text).join('');

test('a completed no-candidate failure is not described as waiting',()=>{
  const view=present({done:true,status:503,error:'no available account',order:[],tries:[]},{},true);
  assert.equal(view.failed,true);
  assert.doesNotMatch(text(view.caption),/等待/);
});
test('an in-progress retry is not a final failure',()=>{
  const view=present({done:false,order:[{id:'a'}],tries:[{id:'a',done:true,status:429}]},{},true);
  assert.equal(view.failed,false);
  assert.match(view.accountState,/改道|重试/);
});
test('one compaction candidate does not imply one enabled account',()=>{
  const view=present({done:true,status:200,compaction:'a',order:[{id:'a',who:'Test',kind:'account'}],tries:[]},{},true);
  assert.doesNotMatch(text(view.caption),/唯一启用/);
});
