"""明确完整HTTP拒绝证据边界，不用header/已开始读流替代完整实体。"""
import httpx,unittest,asyncio
from types import SimpleNamespace
from uuid import uuid4
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.model_transport_accounting import PhysicalModelScope
from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport,organization_request_context
from notalone.application.model_transport_accounting import PhysicalModelCall
class Broken(httpx.SyncByteStream):
 def __iter__(self):
  yield b'{'
  raise httpx.ReadError('synthetic incomplete')
class Control(SharedModelPriorityControl):
 def __init__(self):
  super().__init__(socket_path='/synthetic-unused',token='x'*40);self.records=[];self.permit=str(uuid4())
 @property
 def current_call_identity(self):return {'permit_id':self.permit,'attempt_id':str(uuid4())}
 def reserve_physical_call(self,receipt,**kw):self.records.append(receipt)
 def record_physical_call(self,receipt):self.records.append(receipt)
 def check_physical_dispatch(self):pass
class Cancelled(httpx.SyncByteStream):
 def __iter__(self):
  yield b'partial'
  raise asyncio.CancelledError()
class PhysicalModelResponseProofTest(unittest.TestCase):
 def call(self):
  call=object.__new__(PhysicalModelCall);call.known_rejection=False;call.sdk_response_complete=False;return call
 def test_complete_error(self):
  for status in (400,429,500):
   with self.subTest(status=status):
    call=self.call();call.confirm_complete_http_rejection(httpx.Response(status,content=b'error'))
    self.assertTrue(call.known_rejection);self.assertFalse(call.sdk_response_complete)
 def test_nonerror(self):
  for status in (200,302,399):
   with self.subTest(status=status):
    call=self.call()
    with self.assertRaises(ValueError):call.confirm_complete_http_rejection(httpx.Response(status,content=b'body'))
    self.assertFalse(call.known_rejection)
 def test_header_only(self):
  call=self.call();response=httpx.Response(400,stream=httpx.ByteStream(b'error'))
  with self.assertRaises(ValueError):call.confirm_complete_http_rejection(response)
  self.assertFalse(call.known_rejection);response.close()
 def test_broken_body_consumed_flag_is_not_enough(self):
  call=self.call();response=httpx.Response(400,stream=Broken())
  with self.assertRaises(httpx.ReadError):response.read()
  self.assertTrue(response.is_stream_consumed)
  with self.assertRaises(ValueError):call.confirm_complete_http_rejection(response)
  self.assertFalse(call.known_rejection);response.close()
 def test_cancelled_read_keeps_unknown(self):
  for owner_only in (False,True):
   with self.subTest(owner_only=owner_only):
    c=Control();scope=PhysicalModelScope(c,uuid4(),uuid4(),None if owner_only else uuid4(),'owner_memory' if owner_only else 'contact','deepseek','synthetic')
    transport=OrganizationQualityHTTPTransport(httpx.MockTransport(lambda req:httpx.Response(400,stream=Cancelled())))
    with organization_request_context(lambda:None,lambda *args:None,SimpleNamespace(check=lambda:None,remaining_seconds=lambda:3),SimpleNamespace(max_characters=1000),accounting_scope=scope):
     with self.assertRaises(asyncio.CancelledError):transport.handle_request(httpx.Request('POST','http://127.0.0.1/synthetic',json={}))
    self.assertEqual(c.records[-1]['outcome'],'unknown');transport.close()
if __name__=='__main__':unittest.main()
