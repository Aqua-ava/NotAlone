import type {IncomingMessage,ServerResponse} from 'node:http';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {readWechatHttpBody,WechatHttpBodyError} from '../../sync/wechat-http-body.ts';
import {SqliteSkillLibrary,SqliteSkillError} from './library.ts';
import type {SkillPackageState} from './contracts.ts';

const enabledLabels={enabled:'已启用',disabled:'已停用',unknown:'待核验启停'};
const verificationLabels={verified:'目录已核验',pending:'待核验',missing:'目录或文件缺失',conflict:'目录身份冲突',invalid:'文件校验失败'};
/** 最小业务查询投影不含物理定位，也不冒充旧PG版本或本次实际加载证据。 */
export function skillManagementView(item: SkillPackageState) {
 return {package_id:item.id,name:item.displayName,description:item.description,directory_name:item.directoryName,
  enabled_state:item.enabledState,verification_state:item.verificationState,verification_reason:item.verificationReason,
  head_revision:item.headRevision.toString(),current_revision_no:item.currentRevisionNo?.toString()??null,
  state_label:`${enabledLabels[item.enabledState]} · ${verificationLabels[item.verificationState]}`,
  revisions:item.revisions.map(r=>({revision_no:r.revisionNo.toString(),manifest_digest:r.manifestDigest,content_digest:r.contentDigest,
   source_kind:r.sourceKind,availability:r.availability,verification_state:r.verificationState}))};
}
function object(value: unknown): Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value))throw new SqliteSkillError('skill_request_invalid');
 return value as Record<string,unknown>;
}
function exact(value: Record<string,unknown>,keys: string[]): void {
 if(Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key)))throw new SqliteSkillError('skill_request_invalid');
}
function head(value: unknown): bigint {
 if(typeof value!=='string' || !/^[1-9][0-9]{0,18}$/.test(value))throw new SqliteSkillError('skill_request_invalid');
 return BigInt(value);
}
function respond(res: ServerResponse,status: number,value: unknown): void {
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
/** 复用共享宿主路由，唯一认证函数必须由宿主注入；不接收owner、目录根、SQL或模块地址。 */
export class SqliteSkillHttp {
 private readonly library: SqliteSkillLibrary;
 private readonly authorize: (req: IncomingMessage)=>boolean;
 constructor(library: SqliteSkillLibrary,authorize: (req: IncomingMessage)=>boolean) {this.library=library;this.authorize=authorize;}
 async handle(req: IncomingMessage,res: ServerResponse): Promise<boolean> {
  const raw=req.url??'';let url: URL;
  try {url=new URL(raw,'http://localhost');}catch{return false;}
  const path=url.pathname,legacyLearning=/^\/api\/contacts\/[^/]+\/skill-learning(?:\/|$)/.test(path);
  if(path!=='/api/skills' && !path.startsWith('/api/skills/') && !legacyLearning)return false;
  if(!this.authorize(req)){respond(res,401,{error:'unauthorized'});return true;}
  try {
   if(raw!==path)throw new SqliteSkillError('skill_request_invalid');
   if(legacyLearning){respond(res,503,{error:'sqlite_skill_operation_unavailable'});return true;}
   const match=/^\/api\/skills\/([a-f0-9-]{36})\/(verify|enable|disable)$/.exec(path);
   const query=path==='/api/skills';const discover=path==='/api/skills/discover';
   if(!query && !discover && !match){respond(res,503,{error:'sqlite_skill_operation_unavailable'});return true;}
   if(req.method!==(query?'GET':'POST')){respond(res,405,{error:'method_not_allowed'});return true;}
   if(query){respond(res,200,{storage:'sqlite',mode:'minimal',skills:(await this.library.inspect()).map(skillManagementView)});return true;}
   let parsed: unknown;
   try {parsed=JSON.parse((await readWechatHttpBody(req,16_384,10_000)).toString('utf8'));}
   catch(error){if(error instanceof WechatHttpBodyError)throw error;throw new SqliteSkillError('skill_request_invalid');}
   const body=object(parsed);
   exact(body,discover?['directory_name','confirmed']:['expected_head_revision','confirmed']);
   if(body.confirmed!==true)throw new SqliteSkillError('skill_request_invalid');
   let item: SkillPackageState;
   if(discover){
    if(typeof body.directory_name!=='string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.directory_name))throw new SqliteSkillError('skill_request_invalid');
    item=await this.library.discover(body.directory_name);
   }else{
    const [,id,action]=match!;const expectedHead=head(body.expected_head_revision);
    item=action==='verify'?await this.library.verify(id,expectedHead):await this.library.setEnabled(id,expectedHead,action==='enable'?'enabled':'disabled');
   }
   respond(res,200,{skill:skillManagementView(item)});
  }catch(error){
   const code=error instanceof StorageFailure || error instanceof SqliteSkillError?error.code:error instanceof WechatHttpBodyError?error.code:'skill_operation_failed';
   respond(res,error instanceof WechatHttpBodyError?error.status:code==='skill_request_invalid'?400:409,{error:code});
  }
  return true;
 }
}
