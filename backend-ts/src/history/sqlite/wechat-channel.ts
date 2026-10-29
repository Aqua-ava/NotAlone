import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { HistoryChannel, HistorySupportReport } from './contracts.ts';

/** 最终CLI/WCDB、当前schema和连续性尚未认证；不借status或旧研究摘要签发身份。 */
export function createWechatHistoryChannel():HistoryChannel {
 const report:HistorySupportReport={protocol:'private-history-v1',profileId:'wechat-private-history-unverified-v1',adapterVersion:'1',
  status:'unverified',reason:'wechat_final_artifact_and_schema_unverified',
  accountKey:'unverified',conversationKey:'unverified',sourceGeneration:'unverified',
  programVersion:'unknown',build:'unknown',artifactSha256:'',schemaFingerprint:'',declaredPrimaryKey:[],
  identity:'source-table-local-v1',statusSemantics:'',continuity:''};
 const reject=async():Promise<never>=>{throw new StorageFailure('history_support_unverified');};
 return {inspect:async()=>({...report,declaredPrimaryKey:[]}),target:reject,page:reject};
}
