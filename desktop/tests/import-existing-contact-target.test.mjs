import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

const bundle=await build({stdin:{contents:`
  export {ImportController} from './src/main/imports/controller';
  export {installImportBridge} from './src/main/imports/bridge';
`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {ImportController,installImportBridge}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contactId='10000000-0000-4000-8000-000000000001';

function fixture(){
  const backend={onStateChanged:()=>()=>{},getConnectionGeneration:()=>1,requestJson:async()=>({generation:1,data:{
    valid:true,file_name:'synthetic.jsonl',content_sha256:'a'.repeat(64),record_count:1,kind_counts:{text:1},
    owner_channel_identity:{external_id:'synthetic-owner',observed_name:'合成本人'},
    contact_channel_identity:{external_id:'synthetic-contact',observed_name:'合成联系人'},
  }})};
  const contacts={onStateChanged:()=>()=>{},getState:()=>({directoryPhase:'ready',scopeRevision:1,
    contacts:[{contactId,displayName:'合成联系人',messageCount:0,sourceCount:0}]})};
  const controller=new ImportController(backend,contacts);
  const handlers=new Map();
  installImportBridge({publish:()=>{},handle:(name,handler)=>handlers.set(name,handler)},controller);
  return {controller,handlers};
}

test('历史导入只接受当前已有联系人，新联系人入口在控制器与桥接层均被拒绝',()=>{
  const {controller,handlers}=fixture();
  assert.throws(()=>controller.setTarget({kind:'new',displayName:'未授权合成联系人'}),/本次文件或联系人已变化/);
  assert.throws(()=>handlers.get('imports:set-target')({kind:'new',displayName:'未授权合成联系人'}),/历史导入操作不可用/);
  assert.doesNotThrow(()=>handlers.get('imports:set-target')({kind:'existing',contactId}));
  assert.deepEqual(controller.getState().target,{kind:'existing',contactId});
});

test('确认后提交只携带既有联系人，取消确认使旧版本不可复用',async()=>{
  const {controller}=fixture();
  await controller.chooseFile(async()=>({canceled:false,filePaths:['/synthetic/import.jsonl']}));
  controller.setTarget({kind:'existing',contactId});
  let revision=controller.getState().selectionRevision;
  await controller.preview(revision);
  revision=controller.getState().selectionRevision;
  await controller.confirmPreview(revision);
  const confirmed=controller.takeConfirmedSelection(revision);
  assert.deepEqual(confirmed.body,{path:'/synthetic/import.jsonl',expected_content_sha256:'a'.repeat(64),contact_id:contactId});
  assert.equal('new_contact_name' in confirmed.body,false);

  await controller.chooseFile(async()=>({canceled:false,filePaths:['/synthetic/import-2.jsonl']}));
  revision=controller.getState().selectionRevision;
  await controller.preview(revision);
  revision=controller.getState().selectionRevision;
  await controller.confirmPreview(revision);
  controller.cancelConfirmation(revision);
  await assert.rejects(controller.confirmPreview(revision),/本次文件或联系人已变化/);
});
