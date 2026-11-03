import {NarrowWechatClient} from '../wechat/native-client.ts';
import {loadNarrowWechatOptions} from '../wechat/artifacts.ts';
import {validateLegacyTerminalProof,type LegacyProofContext,type LegacyReaderEvidence,type LegacyTerminalProof} from './legacy-terminal-proof.ts';

/** 本机维护构造期依赖；HTTP请求没有指定制品、配置或映射的入口。 */
export function createNativeLegacyProofProvider(options:{legacyExecutable:string;currentExecutable:string}){
 return async(context:LegacyProofContext,jobSignal?:AbortSignal):Promise<LegacyTerminalProof>=>{
  const probe=async(executable:string):Promise<LegacyReaderEvidence>=>{
   jobSignal?.throwIfAborted();const client=new NarrowWechatClient(await loadNarrowWechatOptions(executable));
   try{const timeout=AbortSignal.timeout(30000),signal=jobSignal?AbortSignal.any([jobSignal,timeout]):timeout;signal.throwIfAborted();const scope=await client.resolveSelected(context.report.conversationKey,signal),schema=await client.inspectSelected(signal),report=await client.supportSelected(signal),target=await client.targetSelected(signal);return{scope,schema,report,target};}
   finally{await client.close();}
  };
  const legacy=await probe(options.legacyExecutable),current=await probe(options.currentExecutable);
  const proof:LegacyTerminalProof={format:'notalone-legacy-recall-mapping-v1',token:structuredClone(context.token),observedAt:Date.now(),legacy,current,
   keys:context.candidates.map(c=>({from:c.key,to:JSON.stringify([context.token.source_generation,...JSON.parse(c.key).slice(1)]),reason:'source_recalled'}))};
  validateLegacyTerminalProof(context,proof,Date.now());return proof;
 };
}
