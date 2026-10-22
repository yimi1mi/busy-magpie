import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceleratorFromEvent} from '../web/hotkey.mjs';
test('recorded shortcuts use physical letters and explicit modifiers',()=>{
  assert.equal(acceleratorFromEvent({key:'k',code:'KeyK',ctrlKey:true,altKey:true}),'Control+Alt+K');
  assert.equal(acceleratorFromEvent({key:'m',code:'KeyM',metaKey:true},'darwin'),'Command+M');
});
test('plain typing and composition are not taken as global shortcuts',()=>{
  assert.equal(acceleratorFromEvent({key:'m',code:'KeyM'}),'');
  assert.equal(acceleratorFromEvent({key:'Process',ctrlKey:true}),'');
  assert.equal(acceleratorFromEvent({key:'F8'}),'F8');
});
