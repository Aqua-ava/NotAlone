import {open,readFile,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {identityActions} from '../src/contacts/sqlite/actions.ts';
import {NarrowWechatClient} from '../src/history/wechat/native-client.ts';
import {loadNarrowWechatOptions} from '../src/history/wechat/artifacts.ts';
import {controlledFiles} from '../src/storage/sqlite/files.ts';
import {legacyRecallCandidates,legacyProofDigest} from '../src/history/sqlite/legacy-terminal-proof.ts';
import {createNativeLegacyProofProvider} from '../src/history/sqlite/legacy-terminal-native-proof.ts';

const args=new Map();for(let i=2;i<process.argv.length;i+=2){if(!['--user-data','--plan-file','--output'].includes(process.argv[i])||!process.argv[i+1]||args.has(process.argv[i]))throw Error('参数无效');args.set(process.argv[i],process.argv[i+1]);}
if(args.size!==3||[...args.values()].some(v=>!path.isAbsolute(v)))throw Error('需要明确的资料目录、已选范围计划和证据输出绝对路径');
const userData=await realpath(args.get('--user-data')),plan=JSON.parse(await readFile(args.get('--plan-file'),'utf8'));
if(plan.requiresMapping?.length!==1)throw Error('本次维护只接受一个明确范围');const scope=plan.requiresMapping[0];
const launch=JSON.parse(await readFile(path.join(userData,'backend-launch.json'),'utf8')),local=JSON.parse(await readFile(path.join(userData,'sqlite-development.json'),'utf8'));
const env=await readFile(launch.envFilePath??path.join(launch.projectDirectory,'.env'),'utf8').catch(()=>''),line=env.split(/\r?\n/).find(x=>/^\s*(?:export\s+)?NOTALONE_WECHAT_CONFIG\s*=/.test(x));
if(line){const value=line.replace(/^\s*(?:export\s+)?NOTALONE_WECHAT_CONFIG\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');if(!path.isAbsolute(value)||/[\r\n\0]/.test(value))throw Error('来源配置无效');process.env.NOTALONE_WECHAT_CONFIG=value;}
const files=controlledFiles(userData,false),database=new DatabaseSync(files.database,{readOnly:true});
const query=(method,sql,values=[])=>{const s=database.prepare(sql);s.setReadBigInts(true);return s[method](...values);};
const tx={get:(sql,values)=>query('get',sql,values),all:(sql,values)=>query('all',sql,values),run(){throw Error('dry-run禁止写入');}};
const eligibility=()=>identityActions.find(a=>a.name==='identity.eligibility').execute(tx,scope);
let intent;
try{
 const instance=tx.get('SELECT database_id,runtime_id,role FROM database_instance WHERE slot=1');if(instance.database_id!==local.expectedDatabaseId||instance.role!==local.role)throw Error('实例身份无效');
 const token=eligibility();if(!tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[scope.ownerId,scope.contactId]))throw Error('来源没有待认证围栏');
 const candidates=legacyRecallCandidates(tx,token);if(!candidates.length||candidates.length>1024)throw Error('维护候选必须非空且在协议上限内');
 const oldArtifact=candidates[0].report.artifactSha256;if(candidates.some(c=>c.report.artifactSha256!==oldArtifact))throw Error('旧读取器证据不唯一');
 let legacyExecutable;const builds=path.dirname(path.dirname(path.dirname(launch.wechatCliPath)));
 for(const base of [userData,builds]){for(const entry of await readdir(base,{withFileTypes:true}).catch(()=>[])){
  if(!entry.isDirectory()||base===userData&&!entry.name.startsWith('wechat-history-'))continue;
  const root=path.join(base,entry.name),manifest=await readFile(path.join(root,'manifest.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(manifest?.cliSha256===oldArtifact){legacyExecutable=path.join(root,'bin/wechat-cli');break;}
 }if(legacyExecutable)break;}
 if(!legacyExecutable)throw Error('找不到精确匹配的旧读取器');
 const client=new NarrowWechatClient(await loadNarrowWechatOptions(launch.wechatCliPath));let current;
 try{const signal=AbortSignal.timeout(30000);await client.resolveSelected(candidates[0].report.conversationKey,signal);await client.inspectSelected(signal);const report=await client.supportSelected(signal),target=await client.targetSelected(signal);current={report,target};}finally{await client.close();}
 const proof=await createNativeLegacyProofProvider({legacyExecutable,currentExecutable:launch.wechatCliPath})({token,...current,candidates});
 if(legacyProofDigest(eligibility())!==legacyProofDigest(token)||tx.get('SELECT runtime_id FROM database_instance WHERE slot=1').runtime_id!==instance.runtime_id)throw Error('取证期间运行身份或授权已变化，请重新取证');
 intent={format:'notalone-legacy-terminal-maintenance-v1',databaseId:String(instance.database_id),ownerId:scope.ownerId,contactId:scope.contactId,legacyExecutable,currentExecutable:launch.wechatCliPath,proof,proofDigest:legacyProofDigest(proof)};
}finally{database.close();}
const output=await open(args.get('--output'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
try{await output.writeFile(JSON.stringify(intent)+'\n');await output.sync();}finally{await output.close();}
console.log(JSON.stringify({verified:true,keys:intent.proof.keys.length,selectedPartitions:intent.proof.current.target.partitions.length,bodyRead:false,businessDataWritten:false}));
