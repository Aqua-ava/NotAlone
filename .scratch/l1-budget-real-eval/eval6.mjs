// 用人工标注（本机，王威 27 个回复时刻）扫描稠密/稀疏权重与综合分门槛。只读，不调用模型。
import {readFileSync,writeFileSync} from 'node:fs';
const {pool,data}=JSON.parse(readFileSync(new URL('./label-data.json',import.meta.url)));
const labels={1:'C03 O44 O39 C01',2:'O42 C03',3:'C01 O44 C03 C17 O39',4:'C03',5:'O36 C05 O20',6:'O37 C05 O27 O26',7:'O27 C07 C04 O37',8:'O31',9:'O32',10:'O46 O47',11:'C16 C14 C17 C05',12:'O30 O25',13:'',14:'C13 C18 C10 O28',15:'O21',16:'C10',17:'O40',18:'C19 C05',19:'C15 C17',20:'C14 O34',21:'O47',22:'O33 O35 C12',23:'C10 C18',24:'',25:'O21 C13',26:'C18 C10 C13 C02',27:'C13 C18 C10'};
writeFileSync(new URL('./labels.json',import.meta.url),JSON.stringify(labels));
const rel=Object.fromEntries(Object.entries(labels).map(([k,v])=>[k,new Set(v.split(' ').filter(Boolean))]));
const totalRel=Object.values(rel).reduce((a,s)=>a+s.size,0);
function run(wd,T){
 let tp=0,fp=0,emptyOk=0,emptyTotal=0,sel=0,hitMoments=0;
 for(const d of data){
  const sc=d.rec.map(r=>({...r,s:wd*r.cos+(1-wd)*r.lex}));
  const pick=(scope,cap)=>sc.filter(r=>r.scope===scope&&r.s>=T).sort((a,b)=>b.s-a.s).slice(0,cap);
  const chosen=[...pick('contact',5),...pick('owner',3)];
  sel+=chosen.length;
  for(const r of chosen)(rel[d.n].has(r.tag)?tp++:fp++);
  if(rel[d.n].size===0){emptyTotal++;if(chosen.length===0)emptyOk++;}
  if(chosen.some(r=>rel[d.n].has(r.tag)))hitMoments++;
 }
 const p=tp/Math.max(1,tp+fp),r=tp/totalRel,f1=2*p*r/Math.max(1e-9,p+r),f05=1.25*p*r/Math.max(1e-9,0.25*p+r);
 return {wd,T,tp,fp,p,r,f1,f05,avg:sel/data.length,emptyOk,emptyTotal,hitMoments};
}
const rows=[];for(const wd of [1,0.9,0.8,0.7,0.6,0])for(let T=0.15;T<=0.70001;T+=0.01)rows.push(run(wd,+T.toFixed(2)));
const fmt=x=>`wd=${x.wd} T=${x.T.toFixed(2)} 精确率${(x.p*100).toFixed(0)}% 召回${(x.r*100).toFixed(0)}% F1=${x.f1.toFixed(2)} F0.5=${x.f05.toFixed(2)} 平均放入${x.avg.toFixed(1)}条 命中时刻${x.hitMoments}/27 无关时刻零放入${x.emptyOk}/${x.emptyTotal}`;
console.log('标注相关总数',totalRel,'；27 个时刻');
for(const wd of [1,0.9,0.8,0.7,0.6,0]){
 const r=rows.filter(x=>x.wd===wd&&x.avg>0);
 const b1=r.reduce((a,b)=>b.f1>a.f1?b:a),b5=r.reduce((a,b)=>b.f05>a.f05?b:a);
 console.log(`\n权重 稠密${wd}/稀疏${(1-wd).toFixed(1)}\n  最佳F1：${fmt(b1)}\n  最佳F0.5：${fmt(b5)}`);
}
console.log('\n0.8/0.2 各门槛：');for(const T of [0.40,0.44,0.46,0.48,0.50,0.52,0.54,0.56,0.58,0.60])console.log('  '+fmt(rows.find(x=>x.wd===0.8&&x.T===T)));
console.log('\n纯字面（现状，词法覆盖率≥0.15，按 5/3 封顶）：');
{let tp=0,fp=0,sel=0;for(const d of data){const c=d.rec.filter(r=>r.scope==='contact'&&r.lex>=0.15).sort((a,b)=>b.lex-a.lex).slice(0,5),o=d.rec.filter(r=>r.scope==='owner'&&r.lex>=0.15).sort((a,b)=>b.lex-a.lex).slice(0,3);for(const r of [...c,...o]){sel++;(rel[d.n].has(r.tag)?tp++:fp++);}}const p=tp/Math.max(1,tp+fp),r=tp/totalRel;console.log(`  精确率${(p*100).toFixed(0)}% 召回${(r*100).toFixed(0)}% F1=${(2*p*r/(p+r)).toFixed(2)} 平均放入${(sel/data.length).toFixed(1)}条`);}
