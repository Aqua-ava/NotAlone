/** 只判断上游传输是否给出协议终态，不判断业务是否提交了合规候选。 */
export function responseEnvelopeComplete(arm,status,raw){
  if(!Number.isInteger(status)||status<200||status>=300)return false;
  const text=Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw);
  if(arm==='old'){
    const values=text.split('\n').map(line=>line.trim())
      .filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
    if(values.at(-1)==='[DONE]')return true;
    try{
      const value=JSON.parse(text);
      return Array.isArray(value.choices)&&value.choices.length>0
        &&value.choices.every(choice=>choice&&typeof choice.finish_reason==='string'&&choice.finish_reason.length>0);
    }catch{return false;}
  }
  if(arm!=='new')return false;
  const events=[];
  for(const line of text.split('\n')){
    if(!line.startsWith('data: '))continue;
    try{events.push(JSON.parse(line.slice(6)));}catch{return false;}
  }
  if(!events.length||events.at(-1)?.type!=='message_stop'||events.some(event=>event?.type==='error'))return false;
  return events.some(event=>event?.type==='message_start')
    &&events.some(event=>event?.type==='message_delta');
}
