/** 小delta默认builder合同对照；两份模块都来自明确Git对象，不读取运行配置。 */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=process.env.NOTALONE_SPEC_DELTA_SOURCE;
if(!root)throw new Error('需要小delta私有双快照');
const before=await import(pathToFileURL(`${root}/base/backend-ts/src/extraction-protocol-contract.ts`).href);
const after=await import(pathToFileURL(`${root}/candidate/backend-ts/src/extraction-protocol-contract.ts`).href);
const facts=[
 [{requires_all_sources:false,conditions:null,event:null}],
 [{requires_all_sources:true,conditions:null,event:null}],
 [{requires_all_sources:true,conditions:[],event:{}}],
];
const contracts=[];
for(const mode of ['legacy-v4','nullable-proof-v3'])for(const input of facts){
 const old=before.buildSourceVerificationContract(input,mode),current=after.buildSourceVerificationContract(input,mode);
 assert.deepEqual(current,old);
 contracts.push({mode,requires_all_sources:input[0].requires_all_sources,extended:Boolean(input[0].event),sha256:createHash('sha256').update(JSON.stringify(current)).digest('hex')});
}
assert.deepEqual(after.buildSourceVerificationContract(facts[0]),before.buildSourceVerificationContract(facts[0]));
assert.notDeepEqual(after.buildSourceVerificationContract(facts[1],'legacy-v4',{require_complete_evidence:true}),before.buildSourceVerificationContract(facts[1],'legacy-v4'));
assert.throws(()=>after.buildSourceVerificationContract(facts[1],'nullable-proof-v3',{require_complete_evidence:true}));
console.log(JSON.stringify({base:'ff45f2ec296c4cead326d2ab6f3cf7770c9396ab',candidate:'4f89bb976dd4086a02b7ae983fee2760d6e4ff64',default_builder_unchanged:true,implicit_default_mode_unchanged:true,explicit_option_is_legacy_only:true,compared_contracts:contracts},null,2));
