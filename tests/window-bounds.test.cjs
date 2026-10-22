const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fitWindowBounds}=require('../src/window-bounds.cjs');
test('a window on a removed monitor is brought into the remaining work area',()=>{
  const result=fitWindowBounds({x:2500,y:100,width:632,height:432},{x:0,y:0,width:1920,height:1040});
  assert(result.x>=0&&result.x+result.width<=1920);assert(result.y+result.height<=1040);
});
test('large windows fit smaller displays while retaining the content ratio',()=>{
  const result=fitWindowBounds({x:-2000,y:-400,width:1232,height:832},{x:-1280,y:0,width:1280,height:720});
  assert(result.x>=-1280);assert(result.y>=0);assert(result.width<=1260);assert(result.height<=700);
  assert(Math.abs((result.width-32)/(result.height-32)-1.5)<0.01);
});
