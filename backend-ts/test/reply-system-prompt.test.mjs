import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {replySystemPrompt} from '../src/reply-system-prompt.ts';
test('保留原背景完整段落权限、推断矛盾和讨论提示，不因迁移缩短语义约束',()=>{
 const materials=['{"scope_kind":"contact","profile_entries":[]}','{"scope_kind":"owner","profile_entries":[]}'];
 const script="import json,sys\nfrom types import SimpleNamespace\nfrom notalone.reply.layered_context import system_material\nfrom notalone.reply.assistant_discussion import DISCUSSION_HISTORY_NOTICE\nprint(json.dumps(dict(background=''.join(system_material(SimpleNamespace(payload_json=x)) for x in json.load(sys.stdin)),notice=DISCUSSION_HISTORY_NOTICE),ensure_ascii=False))";
 const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script],{input:JSON.stringify(materials),encoding:'utf8',env:{...process.env,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:10000}));
 const context={layered_context:{payload_json:materials[0]},owner_layered_context:{payload_json:materials[1]}};
 const actual=replySystemPrompt(context,{});
 assert.ok(actual.endsWith(expected.background));assert.ok(actual.includes(expected.notice));
 assert.ok(!actual.includes('{skills_locations}'));assert.ok(!actual.includes('{skills_list}'));
 const plain=replySystemPrompt({},null);assert.ok(!plain.includes('<relationship_background>'));assert.ok(!plain.includes(expected.notice));
});
