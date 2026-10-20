"""096 退役迁移：隔离旧库合成数据，覆盖正文清理和独立资料保留。"""

import json
import shutil
import unittest
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from tests.integration.persistence import test_database_migrations as support


class StyleSampleRetirementMigrationTest(unittest.TestCase):
    setUp = support.DatabaseMigrationCommandTest.setUp
    _drop_database = support.DatabaseMigrationCommandTest._drop_database
    _run = support.DatabaseMigrationCommandTest._run

    def test_upgrade_erases_transitive_derivatives_and_preserves_independent_inputs(self):
        for path in sorted((support.ROOT / 'database/migrations').glob('*.sql')):
            if int(path.name[:3]) <= 95:
                shutil.copyfile(path, self.migrations / path.name)
        before = self._run()
        self.assertEqual(before.returncode, 0, before.stderr)
        owner, contact, binding, session, sample, kept, dependent, prepared_request = (uuid4() for _ in range(8))
        turn, turn_input, carry, pref, draft, skill, version, comparison, prepared_key, empty_carry = (uuid4() for _ in range(10))
        empty_carry_payload = {"type": "candidate_carry", "metadata_version": 1, "style_sample_ids": []}
        with psycopg.connect(self.database_url) as c:
            c.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (owner,))
            c.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成联系人')", (owner, contact))
            c.execute("INSERT INTO public.skill_library(owner_id) VALUES (%s)", (owner,))
            c.execute("INSERT INTO public.style_sample(id,owner_id,contact_id,save_key,origin_kind,final_text) VALUES (%s,%s,%s,%s,'manual','合成退役样本正文')", (sample, owner, contact, uuid4()))
            c.execute("INSERT INTO public.expression_preference(id,owner_id,confirmed_operation_key,origin_kind,text_content) VALUES (%s,%s,%s,'manual','独立长期偏好')", (pref, owner, uuid4()))
            c.execute("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) VALUES (gen_random_uuid(),%s,'合成独立本人资料','relationship_note',%s,'manual')", (owner, [owner]))
            preserved_memory = c.execute('SELECT to_jsonb(m) FROM public.owner_memory m').fetchone()[0]
            for request, snapshot in ((kept, {'style_references': [], 'style_sample_ids': []}),
                                      (dependent, {'style_references': [{'text': '无use记录的样本正文'}]}),
                                      (prepared_request, {})):
                c.execute("INSERT INTO public.reply_request(id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision) VALUES (%s,%s,%s,%s,%s,'合成输入','completed',1,now(),%s,0)",
                          (request, owner, contact, binding, prepared_key if request == prepared_request else uuid4(), Jsonb(snapshot)))
                c.execute("INSERT INTO public.reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes) VALUES (%s,%s,%s,%s,%s,0,'合成候选','合成依据','[]')", (uuid4(), request, owner, contact, binding))
            c.execute("INSERT INTO public.assistant_session(id,owner_id,contact_id) VALUES (%s,%s,%s)", (session, owner, contact))
            # 旧快照是根字段映射，不使用 dataclass fields 包装；缺少 use/dependency 行仍要退役。
            c.execute("INSERT INTO public.assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload,state,reply_request_id,prepared_context) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'{}','running',%s,%s)",
                      (turn, session, owner, contact, turn_input, prepared_key, binding, 'a'*64, None, Jsonb({'context': {'style_references': [{'text': '冻结样本正文'}]}})))
            c.execute("INSERT INTO public.assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id) VALUES (%s,%s,%s,%s,%s,'generation',%s)", (turn_input, session, owner, contact, binding, turn))
            c.execute("INSERT INTO public.assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content) VALUES (%s,%s,%s,%s,%s,'candidate_carry',%s)",
                      (carry, session, owner, contact, binding, Jsonb({'type':'candidate_carry','metadata_version':1,'style_sample_ids':[str(sample)]})))
            c.execute("INSERT INTO public.assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content) VALUES (%s,%s,%s,%s,%s,'candidate_carry',%s)",
                      (empty_carry, session, owner, contact, binding, Jsonb(empty_carry_payload)))
            c.execute("UPDATE public.assistant_session SET current_input_version_id=%s WHERE id=%s", (carry, session))
            c.execute("INSERT INTO public.skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,private_evidence,batch_key,current_comparison_id) VALUES (%s,%s,%s,%s,'create','{}','[]','synthetic',%s)", (draft, owner, contact, skill, comparison))
            c.execute("INSERT INTO public.skill_review_comparison(id,owner_id,contact_id,draft_id,draft_revision,input_version,input,library_revision,dependency_ids,state,result) VALUES (%s,%s,%s,%s,1,%s,'{}',0,%s,'completed','{}')", (comparison, owner, contact, draft, uuid4(), [sample]))
            c.execute("INSERT INTO public.reply_skill(id,owner_id,name,description) VALUES (%s,%s,'synthetic-retired','样本派生描述')", (skill, owner))
            c.execute("INSERT INTO public.reply_skill_version(id,skill_id,version_number,name,description,content,is_current,review_origin) VALUES (%s,%s,1,'synthetic-retired','派生描述','派生正文',true,true)", (version, skill))
            c.execute("INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,logical_skill_id,scope_kind,dependency_ids) VALUES (%s,%s,%s,%s,%s,'owner',%s)", (version, owner, contact, draft, skill, [sample]))
            c.execute("INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,title,instruction,mapping_state) VALUES (%s,%s,%s,0,'派生标题','派生说明','new')", (version, uuid4(), skill))
        path = support.ROOT / 'database/migrations/096_retire_style_samples.sql'
        shutil.copyfile(path, self.migrations / path.name)
        after = self._run()
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(json.loads(after.stdout)['applied'], [path.name])
        with psycopg.connect(self.database_url) as c:
            for table in ('style_sample', 'reply_style_sample_use', 'style_sample_expression_preference_use', 'style_sample_generation_dependency'):
                self.assertIsNone(c.execute('SELECT to_regclass(%s)', (f'public.{table}',)).fetchone()[0])
            self.assertEqual(c.execute('SELECT id,context_snapshot FROM public.reply_request').fetchall(), [(kept, {})])
            self.assertEqual(c.execute('SELECT count(*) FROM public.reply_candidate').fetchone()[0], 1)
            self.assertEqual(c.execute('SELECT state,input_payload,prepared_context FROM public.assistant_session_turn').fetchone(), ('redacted', None, None))
            self.assertEqual(c.execute('SELECT count(*) FROM public.assistant_session_input WHERE state=\'redacted\' AND content IS NULL').fetchone()[0], 2)
            self.assertIsNone(c.execute('SELECT current_input_version_id FROM public.assistant_session').fetchone()[0])
            self.assertEqual(c.execute('SELECT text_content FROM public.expression_preference').fetchone()[0], '独立长期偏好')
            self.assertEqual(c.execute('SELECT to_jsonb(m) FROM public.owner_memory m').fetchone()[0], preserved_memory)
            self.assertEqual(c.execute('SELECT state,content FROM public.assistant_session_input WHERE id=%s', (empty_carry,)).fetchone(), ('active', empty_carry_payload))
            self.assertEqual(c.execute('SELECT status,strategy,private_evidence FROM public.skill_draft').fetchone(), ('invalidated', None, None))
            self.assertEqual(c.execute('SELECT state,input,result FROM public.skill_review_comparison').fetchone(), ('invalidated', None, None))
            self.assertEqual(c.execute('SELECT status,content,enabled,is_current FROM public.reply_skill_version').fetchone(), ('deleted', None, False, False))
            self.assertEqual(c.execute('SELECT status,description FROM public.reply_skill').fetchone(), ('disabled', '来源功能已退役'))
            self.assertEqual(c.execute('SELECT title,instruction FROM public.reply_skill_method').fetchone(), (None, None))
            self.assertEqual(c.execute('SELECT count(*) FROM public.reply_invalidated_key').fetchone()[0], 2)
        repeated = self._run()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)['applied'], [])
