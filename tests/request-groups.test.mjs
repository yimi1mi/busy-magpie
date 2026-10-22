import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupRequests} from '../web/request-model.mjs';
const row=(id,session,account)=>({id,agent:'codex',session,done:false,time:`2026-10-22T00:00:0${id}Z`,tries:account?[{id:account,done:false}]:[]});
test('same-session requests group while separate sessions stay distinct',()=>{
  const groups=groupRequests([row(1,'a','one'),row(2,'a','two'),row(3,'b','one')]);
  assert.equal(groups.length,2);assert.equal(groups[0].routes.length,2);assert.equal(groups[0].accountCount,2);
});
test('incoming order does not move existing groups or their representative',()=>{
  const rows=[row(1,'b','one'),row(2,'a','one'),row(3,'a','one')];
  assert.deepEqual(groupRequests(rows).map(g=>[g.key,g.route.id]),groupRequests(rows.reverse()).map(g=>[g.key,g.route.id]));
});
test('unknown sessions and accounts are described as unknown',()=>{
  const groups=groupRequests([row(1,'',null),row(2,'',null)]);
  assert.equal(groups.length,1);assert.equal(groups[0].context,'未提供会话');assert.equal(groups[0].accountCount,0);assert.equal(groups[0].pendingAccounts,2);
});
