import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {ForegroundLocator} from '../src/foreground-location-locator.ts';

test('冻结Python定位合同在全部既有合成名单与绑定反例保持等价',async()=>{
 const root=resolve(new URL('../..',import.meta.url).pathname);
 const python=process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python');
 const vectors=JSON.parse(execFileSync(python,[join(root,'backend-ts/test/foreground-location-frozen-fixture.py')],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:`${root}/backend:${root}/backend/src`,NOTALONE_DISABLE_DOTENV:'1'},encoding:'utf8',maxBuffer:16*1024*1024,timeout:15000}));
 assert.ok(vectors.length>=50);
 for(const [index,v] of vectors.entries()){
  const observation={...v.observation,captured_at:new Date().toISOString()};
  if(observation.quality?.layout_verified===false)observation.quality=null;
  const locator=new ForegroundLocator({ownerId:'00000000-0000-4000-8000-000000000101',accountScope:'synthetic-account',probe:{observe:async()=>observation,close:async()=>{},dispose:async()=>{}},sessions:async()=>v.sessions,bindings:async()=>v.bindings});
  try{const actual=await locator.observe({enabled:true});assert.deepEqual(Object.fromEntries(Object.keys(v.expected).map(key=>[key,actual[key]])),v.expected,`冻结合成向量${index}`);}
  finally{await locator.close();}
 }
});
