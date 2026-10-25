import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import './network-guard.mjs';
test('外部目标在Socket连接与DNS之前同步拒绝',()=>{
  assert.throws(()=>net.connect({host:'example.invalid',port:443}),/external_network_forbidden/);
});
