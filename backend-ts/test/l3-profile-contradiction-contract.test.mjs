import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProfile} from '../src/memory/profiles/workspace.ts';
import {DEFAULT_L2_SCENARIO_BUDGET} from '../src/memory/scenarios/workspace.ts';

const first='10000000-0000-4000-8000-000000000001';
const second='10000000-0000-4000-8000-000000000002';
const third='10000000-0000-4000-8000-000000000003';
const memory=(memory_id,revision)=>({memory_id,revision,level:'contact',text:`合成记忆版本${revision}。`,category:'common_fact',provenance_kind:'manual_entry',
 timing:{},event:null,conditions:null,evolution:null,valid_at:null,invalid_at:null,dependency_ids:[],message_ids:[],dependency_manifest:{memory_id,revision}});
const memories=[memory(first,1),memory(first,2),memory(second,1),memory(third,1)];
const refs=[{memory_id:first,revision:1},{memory_id:second,revision:1},{memory_id:third,revision:1}];
const entry=(kind,references)=>({text:'合成背景资料。',kind,section:kind==='contradiction'?'contradictions':kind==='inference'?'insights':'life_context',
 basis:'底层合成记忆提供依据。',temporal_status:kind==='fact'?'stable':'uncertain',uncertainty:kind==='fact'?'':'当前资料尚不能消除不确定性。',references});
const check=(kind,references)=>validateProfile({entries:[entry(kind,references)]},memories,DEFAULT_L2_SCENARIO_BUDGET);

for(const count of [1,3])test(`L3矛盾条目拒绝${count}个底层引用，必须恰有两个不同记忆`,()=>{
 assert.throws(()=>check('contradiction',refs.slice(0,count)),{code:'l3_profile_reference_invalid'});
});

test('L3矛盾条目接受两个合法且身份不同的底层记忆',()=>{
 const checked=check('contradiction',refs.slice(0,2));
 assert.equal(checked.entries.length,1);assert.equal(checked.entries[0].references.length,2);
 assert.deepEqual(checked.entries[0].references.map(ref=>ref.memory_id),[first,second]);
});

test('L3矛盾条目不能用同一记忆的两个不同版本充当左右依据',()=>{
 assert.throws(()=>check('contradiction',[{memory_id:first,revision:1},{memory_id:first,revision:2}]),{code:'l3_profile_reference_invalid'});
});

for(const kind of ['fact','inference'])for(const count of [1,3])test(`L3普通${kind}条目仍接受${count}个合法底层引用`,()=>{
 const checked=check(kind,refs.slice(0,count));
 assert.equal(checked.entries.length,1);assert.equal(checked.entries[0].kind,kind);assert.equal(checked.entries[0].references.length,count);
});
