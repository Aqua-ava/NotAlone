// 仅替代SQLite与外部读取器；实际执行完整CLI入口并捕获所有输出和异常。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const output=[];let closed=0,escaped='';
const fake={accountMetadata:async()=>({status:'verified'}),resolveSelected:async()=>({accountKey:'UNEXPECTED_ACCOUNT_SENTINEL',conversationKey:'synthetic-conversation'})};
class Shared {async run(_id,work){return work(fake);}async close(){closed++;}async stop(){}}
const context=vm.createContext({process:{argv:['node','script','--user-data=/synthetic','--old-executable=/synthetic/old','--executable=/synthetic/new']},console:{log:value=>output.push(String(value))},structuredClone});
const definitions={
 'node:assert/strict':{default:assert},'node:path':{join},
 '../../src/history/wechat/shared-client.ts':{SharedWechatClient:Shared},
 '../../src/history/wechat/artifacts.ts':{loadSharedNarrowWechatOptions:()=>({})},
 '../../../desktop/scripts/upgrade-history-image-cli.mjs':{compareUpgradeScopeEvidence:()=>({status:'verified',scopeCount:1})},
 './sync-replay-support.mjs':{readQuery:()=>[{id:'synthetic-contact',accountKey:'EXPECTED_ACCOUNT_SENTINEL',conversationKey:'synthetic-conversation'}]},
};
const script=new vm.SourceTextModule(await readFile(new URL('../../../scripts/verification/sync-recovery-pair-evidence.mjs',import.meta.url),'utf8'),{context});
await script.link(specifier=>{const values=definitions[specifier];assert.ok(values);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});});
try{await script.evaluate();}catch(error){escaped=String(error);}
const sensitive=[...output,escaped].some(value=>value.includes('ACCOUNT_SENTINEL'));
assert.equal(sensitive,false,'验证脚本不能把账号比较值输出到日志或逸出异常');
assert.equal(escaped,'','入口必须归一化实际渠道失败');assert.equal(context.process.exitCode,1);assert.equal(closed,1);console.log('账号不一致：固定错误码、无私有字段、读者已关闭');
