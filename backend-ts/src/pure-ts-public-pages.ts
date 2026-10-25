/** 桌面原有会话分片／候选版本分页；每片仍先读取并核验权威业务资料。 */
import {createHash} from 'node:crypto';
import {stringifyJson} from './host-json.ts';
type Row=Record<string,any>;
export class PublicTransportError extends Error {
 readonly code:string;readonly status:number;readonly reason:string|undefined;
 constructor(code:string,status=400,reason?:string){super(code);this.code=code;this.status=status;this.reason=reason;}
}
const invalid=(candidate=false):never=>{throw new PublicTransportError(candidate?'assistant_candidate_version_request_invalid':'assistant_session_request_invalid');};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionReadPayload(session:Row,url:URL):Row{
 if(!url.search)return session;
 const query=url.searchParams,part=query.get('read_part'),expected=query.get('read_id');
 if([...query.keys()].some(key=>!['read_part','read_id'].includes(key))||query.getAll('read_part').length!==1||query.getAll('read_id').length>1||part===null||!/^(?:0|[1-9][0-9]{0,15})$/.test(part))return invalid();
 const number=Number(part);if(!Number.isSafeInteger(number)||number>0&&expected===null||expected!==null&&!/^[0-9a-f]{64}$/.test(expected))return invalid();
 const wire=Buffer.from(stringifyJson(session)),id=createHash('sha256').update(wire).digest('hex');
 if(expected!==null&&expected!==id){
  const unavailable=[...(session.turns??[]),...(session.inputs??[])].some(item=>['redacted','unavailable'].includes(item.state));
  throw new PublicTransportError('assistant_session_read_changed',409,unavailable?'source_unavailable':undefined);
 }
 const offsets=[0];while(offsets.at(-1)!<wire.length){let end=Math.min(offsets.at(-1)!+256*1024,wire.length);while(end<wire.length&&(wire[end]&0xc0)===0x80)end--;offsets.push(end);}
 const count=offsets.length-1;if(number>=count)return invalid();
 return {session_id:session.session_id,current_input_version_id:session.current_input_version_id,read_id:id,part_number:number,part_count:count,payload_bytes:wire.length,payload_fragment:wire.subarray(offsets[number],offsets[number+1]).toString('utf8'),next_part:number+1<count?number+1:null};
}
export function candidateHistoryPayload(history:Row,url:URL):Row{
 const versions=(history.versions as Row[]).map(({edit_key:_,...version})=>version);const full:Row={...history,versions};
 if(!url.search)return full;
 const query=url.searchParams,page=query.get('page'),through=query.get('through');
 if([...query.keys()].some(key=>!['page','through'].includes(key))||query.getAll('page').length!==1||query.getAll('through').length>1||page===null||!/^[0-9]+$/.test(page))return invalid(true);
 const number=Number(page);if(!Number.isSafeInteger(number)||number>2147483647||number>0&&through===null||through!==null&&!uuid.test(through))return invalid(true);
 const anchor=through===null?versions.at(-1):versions.find(version=>version.version_id===through);
 if(!anchor)throw new PublicTransportError('not_found',404);
 if(number>anchor.version_number)return invalid(true);
 const version=versions.find(item=>item.version_number===number);if(!version)throw new PublicTransportError('assistant_candidate_version_save_failed',503);
 const {selected_version_id:_,...base}=full;
 return {...base,default_display_version_id:anchor.version_id,versions:[version],page_number:number,version_count:anchor.version_number+1,next_page:number+1<=anchor.version_number?number+1:null};
}
