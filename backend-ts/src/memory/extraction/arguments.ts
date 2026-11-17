/** 只修复可确定的 JSON 语法；根数组仅由调用点显式映射为唯一命名包络。 */
export class ExtractionArgumentsError extends Error {
 readonly code='extraction_arguments_invalid';readonly failure_kind='invalid_output';
 constructor(){super('extraction_arguments_invalid');}
}
class SyntaxFailure extends Error {
 readonly position:number;readonly expected:'key'|'value'|'colon'|'separator'|'end';
 constructor(position:number,expected:SyntaxFailure['expected']){super('json_syntax');this.position=position;this.expected=expected;}
}
/** 保留重复键检查；不使用 JSON.parse 的末值覆盖作为权限或来源协议。 */
function parse(raw:string,allowControls:boolean):unknown {
 let index=0,depth=0;
 const fail=(expected:SyntaxFailure['expected']):never=>{throw new SyntaxFailure(index,expected);};
 const whitespace=()=>{while(/[\x20\x09\x0a\x0d]/.test(raw[index]??'!'))index++;};
 const string=()=>{
  const start=index++;
  let decoded='';
  while(index<raw.length){
   const character=raw[index++]!;
   if(character==='"')return decoded;
   if(character==='\\'){
    const escape=raw[index++];
    if(escape==='u'){
     const code=raw.slice(index,index+4);if(!/^[0-9a-f]{4}$/i.test(code))fail('value');
     decoded+=String.fromCharCode(Number.parseInt(code,16));index+=4;
    }else{
     const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
     if(escape===undefined||!Object.hasOwn(escapes,escape))fail('value');decoded+=escapes[escape];
    }
   }else{if(character.charCodeAt(0)<32&&!allowControls)fail('value');decoded+=character;}
  }
  index=Math.max(index,start);return fail('end');
 };
 const value=():unknown=>{
  whitespace();if(++depth>128)throw new ExtractionArgumentsError();
  try{
   const character=raw[index];
   if(character==='"')return string();
   if(character==='{'){
    index++;whitespace();const result:Record<string,unknown>={},keys=new Set<string>();
    if(raw[index]==='}'){index++;return result;}
    for(;;){
     whitespace();if(raw[index]!=='"')return fail('key');const key=string();
     if(keys.has(key))throw new ExtractionArgumentsError();keys.add(key);
     whitespace();if(raw[index++]!==':'){index--;return fail('colon');}
     Object.defineProperty(result,key,{value:value(),writable:true,enumerable:true,configurable:true});
     whitespace();if(raw[index]==='}'){index++;return result;}if(raw[index++]!==','){index--;return fail('separator');}
    }
   }
   if(character==='['){
    index++;whitespace();const result:unknown[]=[];if(raw[index]===']'){index++;return result;}
    for(;;){result.push(value());whitespace();if(raw[index]===']'){index++;return result;}if(raw[index++]!==','){index--;return fail('separator');}}
   }
   for(const [literal,parsed] of [['true',true],['false',false],['null',null]] as const){if(raw.startsWith(literal,index)){index+=literal.length;return parsed;}}
   const number=raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
   if(number){index+=number[0].length;const parsed=Number(number[0]);if(!Number.isFinite(parsed))throw new ExtractionArgumentsError();return parsed;}
   return fail('value');
  }finally{depth--;}
 };
 const result=value();whitespace();if(index!==raw.length)fail('end');return result;
}
/**
 * 完整值之后仅剩至多三个收尾括号（可夹空白）时，丢弃这段尾部。被丢弃的部分不含数据，已解析的值原样保留；
 * 结构校验、重复键检查与来源核验仍照常执行。空尾部（如字符串未结束）与任何其他尾随内容都不匹配。
 */
function strayClosersAt(text:string,error:SyntaxFailure):number|null{
 return error.expected==='end'&&/^\s*[\]}](?:\s*[\]}]){0,2}\s*$/.test(text.slice(error.position))?error.position:null;
}
function argumentValue(raw:string,options:{repair:boolean;field_names:readonly string[];drop_stray_closers:boolean}):{value:unknown;repaired:boolean}{
 try{return {value:parse(raw,false),repaired:false};}
 catch(error){
  if(!(error instanceof SyntaxFailure))throw new ExtractionArgumentsError();
  const cut=options.drop_stray_closers?strayClosersAt(raw,error):null;
  if(cut!==null)try{return {value:parse(raw.slice(0,cut),false),repaired:true};}catch{throw new ExtractionArgumentsError();}
  if(!options.repair)throw new ExtractionArgumentsError();
 }
 let fixed=raw.trim();
 if(fixed.startsWith('```json\n')&&fixed.endsWith('```'))fixed=fixed.slice(8,-3).trim();
 else if(fixed.startsWith('```\n')&&fixed.endsWith('```'))fixed=fixed.slice(4,-3).trim();
 for(let attempt=0;attempt<=8;attempt++){
  try{return {value:parse(fixed,true),repaired:true};}
  catch(error){
   if(!(error instanceof SyntaxFailure)||attempt===8)throw new ExtractionArgumentsError();
   const cut=options.drop_stray_closers?strayClosersAt(fixed,error):null;
   if(cut!==null){fixed=fixed.slice(0,cut);continue;}
   const position=error.position,match=fixed.slice(position).match(/^([A-Za-z_][A-Za-z_0-9]*)"\s*:/);
   if(error.expected==='key'&&match&&options.field_names.includes(match[1]!)){fixed=fixed.slice(0,position)+'"'+fixed.slice(position);continue;}
   const prefix=fixed.slice(0,position).trimEnd();
   if(['key','value'].includes(error.expected)&&['}',']'].includes(fixed[position]??'')&&prefix.endsWith(',')){
    fixed=prefix.slice(0,-1)+fixed.slice(position);continue;
   }
   throw new ExtractionArgumentsError();
  }
 }
 throw new ExtractionArgumentsError();
}
export function readExtractionToolArguments(blocks:readonly unknown[],name:string,options:{repair?:boolean;field_names?:readonly string[];root_array_key?:string;allow_text_json?:boolean;drop_stray_closers?:boolean}={}):{value:Record<string,unknown>;repaired:boolean}{
 const calls=blocks.filter((block):block is Record<string,unknown>=>Boolean(block&&typeof block==='object'&&(block as Record<string,unknown>).type==='tool-call'));
 let raw:string,textJson=false;
 if(calls.length===0&&options.allow_text_json===true){
  // 仅由提取调用点显式允许唯一文本包络；已有工具、多个文本或媒体不能借此回退。
  const texts=blocks.filter((block):block is Record<string,unknown>=>Boolean(block&&typeof block==='object'&&(block as Record<string,unknown>).type==='text'));
  if(texts.length!==1||typeof texts[0]!.text!=='string'||blocks.some(block=>!block||typeof block!=='object'||!['text','reasoning'].includes(String((block as Record<string,unknown>).type))))throw new ExtractionArgumentsError();
  raw=texts[0]!.text;textJson=true;
 }else{
  if(calls.length!==1||calls[0]!.name!==name||typeof calls[0]!.arguments!=='string')throw new ExtractionArgumentsError();
  raw=calls[0]!.arguments;
 }
 const decoded=argumentValue(raw,{repair:options.repair??false,field_names:options.field_names??[],drop_stray_closers:options.drop_stray_closers??false});
 if(Array.isArray(decoded.value)&&options.root_array_key)
  return {value:{[options.root_array_key]:decoded.value},repaired:true};
 if(!decoded.value||typeof decoded.value!=='object'||Array.isArray(decoded.value))throw new ExtractionArgumentsError();
 return {value:decoded.value as Record<string,unknown>,repaired:decoded.repaired||textJson};
}
