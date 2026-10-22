import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelUsage,modelValue,modelColor} from '../web/model-usage.mjs';

test('model shares use the same input output and cache total as the pill',()=>{
  const data={input:10,output:10,cache_read:80,cache_write:0,models:[
    {id:'a',model:'one',input:5,output:5,cache_read:60},
    {id:'b',model:'two',input:5,output:5,cache_read:20},
  ]};
  const view=modelUsage(data);
  assert.equal(view.total,100);assert.equal(view.rows[0].share,0.7);
  assert.equal(modelUsage(data,'output').rows[0].share,0.5);
});
test('model color is stable across ordering and periods',()=>{
  const a=modelUsage({input:3,models:[{id:'a',input:1},{id:'b',input:2}]}).rows.find(x=>x.key==='a');
  const b=modelUsage({input:4,models:[{id:'b',input:1},{id:'a',input:3}]}).rows.find(x=>x.key==='a');
  assert.equal(a.color,b.color);assert.equal(a.color,modelColor('a'));
});
test('missing breakdown and zero usage never fabricate model progress',()=>{
  assert.equal(modelUsage({input:0,models:[{id:'a',input:0}]}).rows[0].share,0);
  assert.equal(modelUsage({input:10}).rows.length,0);
  assert.equal(modelValue({input:-2,output:Infinity}),0);
  assert.equal(modelUsage({input:1,models:[{input:2}]}).consistent,false);
});
