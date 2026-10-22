import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recentRequests,requestFailed,attemptRows,redactDiagnostic,requestSummary,RequestSelection} from '../web/request-model.mjs';
test('recovered upstream errors are not final request failures',()=>{
  const route={id:1,done:true,status:200,tries:[{id:'a',done:true,status:429},{id:'b',done:true,status:200}]};
  assert.equal(requestFailed(route),false);assert.equal(attemptRows(route)[0].state,'失败后改道');
  assert.equal(recentRequests({routes:[route]},'failed').length,0);
});
test('pinned requests survive newer requests and cannot alias a new gateway ID',()=>{
  const old={id:1,time:'2026-10-22T01:00:00Z',done:false};
  const select=new RequestSelection();select.select(old,{pid:1});
  select.update({pid:1,routes:[old,{id:2,time:'2026-10-22T02:00:00Z'}]});assert.equal(select.snapshot.id,1);
  select.update({pid:2,routes:[{id:1,model:'new'}]});assert.equal(select.snapshot,old);assert.equal(select.previousGateway,true);
});
test('copied summaries remove credentials and account names',()=>{
  const text=requestSummary({id:1,done:true,status:401,error:'Bearer secret-value user@example.com sk-test-123 token=abcd',tries:[]});
  for(const secret of ['secret-value','user@example.com','sk-test-123','abcd'])assert(!text.includes(secret));
  assert(!redactDiagnostic('https://user:pass@example.org/test').includes('user:pass'));
});
