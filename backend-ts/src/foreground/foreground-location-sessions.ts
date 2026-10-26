/** 全类型名单仅用于前台名称消歧；不能由此建立授权、绑定或读取正文。 */
import {BoundedWechatCliRunner,type WechatCliRunner} from '../sync/wechat-setup-probe.ts';
import {ForegroundLocationError,type ForegroundSession} from './foreground-location-locator.ts';
export class ForegroundSessions {
  private readonly runner:WechatCliRunner;
  private closed=false;
  constructor(options:{executable?:string;environment?:NodeJS.ProcessEnv;runner?:WechatCliRunner}) {
    this.runner=options.runner??new BoundedWechatCliRunner({executable:options.executable??'',environment:options.environment});
  }
  async sessions(options:{signal:AbortSignal;timeoutMs:number;limit:number;keyword?:string}):Promise<ForegroundSession[]> {
    const check=()=>{if(this.closed||options.signal.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');};
    check();
    if(![51,5000].includes(options.limit)||!(options.timeoutMs>0&&options.timeoutMs<=250))throw new ForegroundLocationError('binding_verification_unavailable');
    const args=['sessions','--type-filter','all','--limit',String(options.limit),'--strict-read-only'];
    if(options.keyword!==undefined)args.push('--keyword',options.keyword);
    const data=await this.runner.run(args,options.timeoutMs,options.signal) as {sessions?:unknown};check();
    if(!data||!Array.isArray(data.sessions)||data.sessions.length>options.limit)throw new ForegroundLocationError('binding_verification_unavailable');
    return data.sessions.map(row=>{
      if(!row||typeof row.username!=='string'||typeof row.display_name!=='string'||[...row.display_name].length>256||typeof row.chat_type!=='string')throw new ForegroundLocationError('binding_verification_unavailable');
      // 不保留CLI附带的summary、消息、时间或路径；重复身份与全类型交给定位消歧。
      return {username:row.username,display_name:row.display_name,chat_type:row.chat_type};
    });
  }
  async close():Promise<void>{this.closed=true;await this.runner.close();}
}
