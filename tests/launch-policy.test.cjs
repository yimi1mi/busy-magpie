const {test}=require('node:test');
const assert=require('node:assert/strict');
const {heartbeat,heartbeatState}=require('../src/launch-policy.cjs');

test('explicit quit stays stopped after heartbeat becomes stale',()=>{
  const beat=heartbeat({keepAlive:true},0,true);
  assert.equal(beat.keepAlive,false);
  assert.equal(heartbeatState(beat,0,600000),'off');
});
test('a crash can recover but a pause waits until its deadline',()=>{
  assert.equal(heartbeatState(heartbeat({keepAlive:true},0),0,40000),'dead');
  const beat=heartbeat({keepAlive:true,pauseUntil:60000},0);
  assert.equal(beat.keepAlive,false);
  assert.equal(heartbeatState(beat,0,40000),'off');
  assert.equal(heartbeatState(beat,0,70000),'dead');
});
test('manual relaunch replaces the stop marker without disabling crash recovery',()=>{
  const beat=heartbeat({keepAlive:true,pauseUntil:0},100);
  assert.equal(heartbeatState(beat,100,200),'alive');
  assert.equal(heartbeatState(beat,100,50000),'dead');
});
test('legacy timestamps and disabled keep-alive remain compatible',()=>{
  assert.equal(heartbeatState(100,100,200),'alive');
  assert.equal(heartbeatState({keepAlive:false},100,50000),'off');
});
