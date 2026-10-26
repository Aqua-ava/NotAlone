import test from 'node:test';
import assert from 'node:assert/strict';
import {ForegroundSessions} from '../src/foreground/foreground-location-sessions.ts';
test('完整名单保留群聊及未绑定竞争者，只投影定位字段',async()=>{
  const sessions=new ForegroundSessions({runner:{run:async()=>({sessions:[{username:'fixture-a',display_name:'合成同名',chat_type:'private',summary:'DO_NOT_KEEP'},{username:'fixture-group',display_name:'合成同名',chat_type:'group',content:'DO_NOT_KEEP'}]}),close:async()=>{}}});
  assert.deepEqual(await sessions.sessions({signal:new AbortController().signal,timeoutMs:250,limit:5000}),[{username:'fixture-a',display_name:'合成同名',chat_type:'private'},{username:'fixture-group',display_name:'合成同名',chat_type:'group'}]);
  await sessions.close();
});
