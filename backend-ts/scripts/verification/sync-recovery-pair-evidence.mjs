#!/usr/bin/env node
/** 正规配对后，以全部有效会话的当前元数据对照制品变化；不读正文、不修改读取器配置。 */
import {join} from 'node:path';
import {SharedWechatClient} from '../../src/history/wechat/shared-client.ts';
import {loadSharedNarrowWechatOptions} from '../../src/history/wechat/artifacts.ts';
import {compareUpgradeScopeEvidence} from '../../../desktop/scripts/upgrade-history-image-cli.mjs';
import {readQuery} from './sync-replay-support.mjs';

const safeCodes=new Set(['history_image_upgrade_scope_mismatch','history_snapshot_window_changed','history_snapshot_closed','history_native_unavailable','history_source_unverified','body_operation_forbidden']);
const safeCode=error=>{const code=error?.code??error?.message;return safeCodes.has(code)?code:'sync_pair_verification_failed';};
async function main(){
const args=new Map(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return [value.slice(2,at),value.slice(at+1)];}));
const file=join(args.get('user-data'),'managed/sqlite/notalone.sqlite');
const scopes=readQuery(file,`SELECT DISTINCT p.id,a.external_key accountKey,c.external_key conversationKey
 FROM owner o JOIN contact p ON p.owner_id=o.owner_id
 JOIN conversation_binding b ON b.owner_id=p.owner_id AND b.contact_id=p.id
 JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
 JOIN read_grant g ON g.owner_id=b.owner_id AND g.binding_id=b.id AND g.contact_id=p.id
 JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id AND v.binding_id=b.id
 WHERE o.state='active' AND o.read_enabled=1 AND p.state='active' AND b.state='verified'
 AND a.identity_state='verified' AND a.scope_mode='selected' AND g.revoked_at IS NULL
 AND g.selection_generation=p.selection_generation AND v.identity_generation=b.identity_generation ORDER BY p.id`);
async function evidence(executable) {
 const shared=new SharedWechatClient(()=>loadSharedNarrowWechatOptions(executable));
 const result={account:null,scopes:[],transientRetries:0};
 try{
  for(const selected of scopes){
   for(let attempt=0;attempt<3;attempt++){try{
    result.scopes.push(await shared.run(selected.id,async native=>{
    for(const name of ['pageSelected','tailSelected','quarantinePageSelected','openImageSelected','readImageSelected','readQuoteSelected','boundarySnapshotSelected'])native[name]=()=>{throw new Error('body_operation_forbidden');};
    result.account??=await native.accountMetadata();
    const scope=await native.resolveSelected(selected.conversationKey);
    if(scope.accountKey!==selected.accountKey)throw new Error('history_image_upgrade_scope_mismatch');
    return {scope,inspection:await native.inspectSelected(),support:await native.supportSelected(),target:await native.targetSelected()};
    }));break;
   }catch(error){if(attempt===2||!['history_snapshot_window_changed','history_snapshot_closed','history_native_unavailable'].includes(error?.code))throw error;result.transientRetries++;await shared.stop();}}
  }
 }finally{await shared.close();}
 return result;
}
const before=await evidence(args.get('old-executable')),after=await evidence(args.get('executable'));
try{
 // 默认按“新增 recoverFromLocalIds 能力”的配对核对；仅改图片读取等不改能力的配对传 --capability-upgrade=none。
 const comparison=compareUpgradeScopeEvidence(before,after,args.get('capability-upgrade')==='none'?{}:{localIdRecoveryUpgrade:true});
 console.log(JSON.stringify({status:comparison.status,scopes:comparison.scopeCount,bodyOperations:0,configurationWrites:0,transientRetries:before.transientRetries+after.transientRetries}));
}catch(error){
 // 失败只报告结构字段名，绝不打印字段值、会话键或展示名称。
 const differences=new Map(),indexed=new Map(after.scopes.map(scope=>[scope.scope.conversationKey,scope]));
 const normalize=value=>{const copy=structuredClone(value);delete copy.support.artifactSha256;delete copy.support.capabilities.recoverFromLocalIds;delete copy.target.descriptor;return copy;};
 const walk=(a,b,path='')=>{if(JSON.stringify(a)===JSON.stringify(b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const key of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[key],b[key],path?`${path}.${Array.isArray(a)?'*':key}`:key);}else differences.set(path,(differences.get(path)??0)+1);};
 for(const scope of before.scopes)walk(normalize(scope),normalize(indexed.get(scope.scope.conversationKey)));
 console.log(JSON.stringify({status:'mismatch',code:safeCode(error),differenceFields:Object.fromEntries(differences),transientRetries:before.transientRetries+after.transientRetries}));process.exitCode=1;
}

}
await main().catch(error=>{console.log(JSON.stringify({status:'failed',code:safeCode(error)}));process.exitCode=1;});
