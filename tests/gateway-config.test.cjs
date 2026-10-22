const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseGateway,gatewayProblem}=require('../src/gateway-config.cjs');
test('local addresses retain explicit protocol and ports',()=>{
  assert.equal(parseGateway('localhost:3500'),'http://127.0.0.1:3500');
  assert.equal(parseGateway('0.0.0.0:3425'),'http://127.0.0.1:3425');
  assert.equal(parseGateway('https://[::1]:443'),'https://[::1]:443');
  assert.equal(parseGateway('http://127.0.0.1:80'),'http://127.0.0.1:80');
});
test('bad addresses fail visibly instead of silently selecting a default',()=>{
  for(const value of ['not an address','127.0.0.1:99999','ftp://localhost','https://user:pass@localhost','127.0.0.1:3425/v1','127.0.0.1?token=secret','https://example.com'])assert.throws(()=>parseGateway(value));
});
test('a missing interface is distinguished from a stopped gateway',()=>{
  assert.match(gatewayProblem({status:404}),/接口不存在/);
  assert.match(gatewayProblem({cause:{code:'ECONNREFUSED'}}),/未启动/);
});
