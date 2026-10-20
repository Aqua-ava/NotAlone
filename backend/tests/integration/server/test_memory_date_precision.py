"""原始日历精度经正式直接提取、HTTP、分层与冻结回复保存。"""
from unittest.mock import patch
from uuid import UUID, uuid4
import unittest
from tests.integration.server import test_memory_event_updates as events
from tests.integration.server import test_memory_temporal_evidence as temporal
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, tool_response
from tests.fidelity_http_support import FidelityControlledModel
from notalone.memory_extraction.dimensions import DimensionRelease


class DirectEventModel(events.EventScriptedModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.wait_for_response()
        names = [item.get('function', {}).get('name') for item in kwargs.get('tools', [])]
        index = len(self.seen_calls)
        if names == ['DirectMemoryExtractionOutput'] and index < len(self.responses):
            call = self.responses[index].tool_calls[0]
            if call['name'] == 'MemoryExtractionOutput':
                self.responses[index] = tool_response('DirectMemoryExtractionOutput', {
                    'scenes':[{'scene_name':'合成时间','memories':call['args']['facts']}]})
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryDatePrecisionHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = DimensionRelease()
    extraction_model_factory = DirectEventModel
    reply_model_factory = FidelityControlledModel
    import_event = events.MemoryEventUpdatesHttpTest.import_event
    delete_source = events.MemoryEventUpdatesHttpTest.delete_source
    generate = temporal.MemoryTemporalEvidenceHttpTest.generate

    def _backend(self, owner_id):
        from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
        from notalone.tasks.worker import PostgresMemoryExtractionRunner
        def runner(*args, **kwargs):
            return PostgresMemoryExtractionRunner(*args, **kwargs, automatic=False)
        with patch('tests.integration.server.core_business_flow_support.LangChainExtractionRuntime', DirectExtractionRuntime), patch(
                'tests.integration.server.core_business_flow_support.PostgresMemoryExtractionRunner',runner):
            return super()._backend(owner_id)

    def test_source_offset_and_year_precision_survive_api_and_frozen_reply(self):
        imported = self.import_event(original='去年参加了读书会。', claim='去年参加了读书会。',
            when='2030-01-01T00:30:00+08:00', event_spec={'version':2,'stage':'occurred',
                'occurrence_precision':'year','occurrence_expression':'去年',
                'occurrence_start':'2029-01-01T00:00:00+08:00','occurrence_end':'2030-01-01T00:00:00+08:00'},
            event_verification={'stage_verdict':'supported','occurrence_verdict':'supported'})
        contact = imported['contact_id']
        candidate = self._get(self.backend,f'/api/contacts/{contact}/memory-candidates')['candidates'][0]
        self.assertEqual(candidate['timing']['source_started_at'],'2030-01-01T00:30:00+08:00')
        self.assertEqual(candidate['event']['occurrence_precision'],'year')
        self.assertTrue(candidate['event']['occurrence_verified'])
        self.bindings.create_binding(owner_id=self.owner_id,contact_id=UUID(contact),channel='wechat',
            account_scope=f'synthetic-{self.owner_id}',conversation_locator=f'synthetic-{contact}')
        status, confirmed = self.backend.request(f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/confirm",{})
        self.assertEqual(status,200,confirmed)
        status, reply = self.generate(contact)
        self.assertEqual(status,200,reply)
        event = next(item['event'] for item in self.reply_model.payloads[-1]['evidence'] if item['kind']=='confirmed_memory')
        self.assertEqual(event,candidate['event'])
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        restored = self._get(self._backend(self.owner_id),path)
        self.assertEqual(next(item['event'] for item in restored['evidence'] if item['kind']=='confirmed_memory'),event)
        self.delete_source(contact,imported['source']['source_id'])
        self.assertEqual(self.backend.request(path)[0],404)

    def import_date_messages(self, entries):
        import json
        from pathlib import Path
        from datetime import datetime
        path = Path(self.temporary.name) / f'dates-{uuid4().hex}.jsonl'
        locator = f'wxid_synthetic_{uuid4().hex}'
        rows=[]
        for number,(text,when,event) in enumerate(entries,1):
            rows.append({'id':{'local_id':number,'server_id_str':uuid4().hex,'talker':locator},
                'is_from_me':False,'kind':'text','sender':'合成日期联系人','sender_wxid':locator,'text':text,
                **({'create_time':int(datetime.fromisoformat(when).timestamp()),'time_iso':when,'time':datetime.fromisoformat(when).strftime('%Y-%m-%d %H:%M:%S')} if when else {})})
        rows.append({**rows[0], 'id': {**rows[0]['id'], 'local_id': len(rows)+1, 'server_id_str': uuid4().hex},
            'is_from_me': True, 'sender': '合成用户', 'sender_wxid': f'wxid_synthetic_{self.backend.token}', 'text': '合成收到。'})
        path.write_text('\n'.join(json.dumps(row,ensure_ascii=False) for row in rows),encoding='utf-8')
        gate=self.extraction_model.pause_next_response()
        status,imported=self.backend.request('/api/imports/commit',{'path':str(path),'new_contact_name':'合成日期联系人'})
        self.assertEqual(status,200,imported)
        contact=imported['contact_id']
        messages=self._get(self.backend,f'/api/contacts/{contact}/messages')['messages']
        facts=[]
        results=[]
        for text,when,spec in entries:
            mid=next(item['message_id'] for item in messages if item['text']==text)
            pos={'message_id':mid,'char_start':0,'char_end':len(text)}
            event={'version':2,'stage':'planned','stage_evidence':[pos],'occurrence_evidence':[pos],
                'anchor_message_id':mid,**spec}
            facts.append({'text':text,'category':'relationship_note','subject':'contact','topic':'other',
                'source_message_ids':[mid],'confidence':0.95,'risk_flags':[],'valid_at':None,'invalid_at':None,
                'speech_act':'plan','assertion_status':'asserted','figurative_type':'literal','alternatives':[],
                'interpretation_reason':'合成明确计划。','event':event})
            results.append({'candidate_index':len(facts)-1,'verdict':'supported','issues':[],
                'evidence':[{'message_id':mid,'quote':text}],
                'event_verification':{'stage_verdict':'supported','occurrence_verdict':'supported' if spec['occurrence_start'] else 'uncertain',
                    'stage_evidence':[pos],'occurrence_evidence':[pos]}})
        self.extraction_model.responses.extend([tool_response('MemoryExtractionOutput',{'facts':facts}),
            tool_response('SourceVerificationOutput',{'results':results}),
            tool_response('MemoryAdjudicationOutput',{'action':'add','replaced_memory_id':None})])
        gate.set()
        self._wait_finished(self.backend,contact)
        return self._get(self.backend,f'/api/contacts/{contact}/memory-candidates')['candidates']

    def test_each_relative_day_uses_its_own_message_and_source_offset(self):
        candidates=self.import_date_messages([
            ('明天计划去看展。','2030-01-31T23:30:00+08:00',{'occurrence_precision':'day',
                'occurrence_expression':'明天','occurrence_start':'2030-02-01T00:00:00+08:00','occurrence_end':'2030-02-02T00:00:00+08:00'}),
            ('明天计划去游泳。','2030-02-02T23:30:00-07:00',{'occurrence_precision':'day',
                'occurrence_expression':'明天','occurrence_start':'2030-02-03T00:00:00-07:00','occurrence_end':'2030-02-04T00:00:00-07:00'})])
        self.assertEqual(len(candidates),2)
        by_text={item['text']:item for item in candidates}
        self.assertEqual(by_text['明天计划去看展。']['event']['occurrence_start'],'2030-02-01T00:00:00+08:00')
        self.assertEqual(by_text['明天计划去游泳。']['event']['occurrence_start'],'2030-02-03T00:00:00-07:00')
        self.assertEqual(by_text['明天计划去游泳。']['timing']['source_started_at'],'2030-02-02T23:30:00-07:00')

    def test_owner_month_precision_reaches_layered_references_without_private_anchor(self):
        import json
        imported=self.import_event(original='上月参加读书会。',claim='上月参加读书会。',subject='self',
            when='2030-01-15T00:30:00-07:00',event_spec={'version':2,'stage':'occurred',
                'occurrence_precision':'month','occurrence_expression':'上月',
                'occurrence_start':'2029-12-01T00:00:00-07:00','occurrence_end':'2030-01-01T00:00:00-07:00'},
            event_verification={'stage_verdict':'supported','occurrence_verdict':'supported'})
        contact=imported['contact_id']
        candidate=self._get(self.backend,f'/api/contacts/{contact}/memory-candidates')['candidates'][0]
        status,result=self.backend.request(f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/confirm",{})
        self.assertEqual(status,200,result)
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        backend=LayeredProfileHttpTest.controlled(self)
        path='/api/memories/owner/layered-memory'
        state=self._get(backend,path)['layered_memory']
        status,result=backend.request(path+'/enable',{'settings_generation':state['settings_generation'],'purpose_confirmed':True})
        self.assertEqual(status,200,result)
        layered=result['layered_memory']
        for reference in (layered['scenarios'][0]['paragraphs'][0]['references'][0],layered['profile']['entries'][0]['references'][0]):
            self.assertEqual(reference['event'],candidate['event'])
        projected=self.profile_proposer.inputs[0][0][0]['paragraphs'][0]['references'][0]['timing']['event']
        self.assertEqual(projected['occurrence_precision'],'month')
        self.assertEqual(projected['occurrence_expression'],'上月')
        self.assertNotIn('anchor_message_id',json.dumps(projected))
        self.assertNotIn(imported['message']['message_id'],json.dumps(projected))

    def test_wrong_calendar_date_is_unknown_even_when_external_verifier_says_supported(self):
        candidates=self.import_date_messages([('明天计划去看展。','2030-01-31T23:30:00+08:00',
            {'occurrence_precision':'day','occurrence_expression':'明天',
             'occurrence_start':'2030-01-31T00:00:00+08:00','occurrence_end':'2030-02-01T00:00:00+08:00'})])
        self.assertEqual(len(candidates),1)
        event=candidates[0]['event']
        self.assertEqual(event['occurrence_precision'],'unknown')
        self.assertIsNone(event['occurrence_start'])
        self.assertFalse(event['occurrence_verified'])
        self.assertEqual(event['occurrence_expression'],'明天')
