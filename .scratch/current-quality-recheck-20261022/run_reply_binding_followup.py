"""保留首次绑定缺失的409，补齐合成绑定后重放未外发案例并覆盖两种输入模式。"""
import argparse
import json
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.memory.organization_quality_suite_budget import atomic_json

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
root=parser.parse_args().output.expanduser().resolve()
identity=json.loads((root/'database.json').read_text())
assert identity['database_name'].startswith('notalone_core_flow_') and identity['database_name'].endswith('_test')
owner=UUID(identity['owner_id'])
repository=PostgresConversationBindingRepository('host=/tmp dbname='+identity['database_name'])
cases=[]
for name in ('empty_history','negation'):
    previous=json.loads((root/f'reply-{name}.json').read_text())
    assert previous['response']=={'error':'reply_rejected','reason':'no_active_binding'}
    body=previous['request']
    contact=UUID(body['contact_id'])
    repository.create_binding(owner_id=owner,contact_id=contact,channel='wechat',
        account_scope='synthetic-current-quality',conversation_locator='synthetic-'+contact.hex)
    body['idempotency_key']=str(uuid4())
    cases.append((name+'-after-binding',body))
main=json.loads((root/'reply-negation.json').read_text())['request']['contact_id']
for name,content in (
    ('pasted-negation',{'type':'rewrite_draft','input_kind':'current_chat',
        'draft_text':'不是不想见你，只是这周工作太忙了。','pasted_direction':'表示理解，不催促，不约定下次见面的时间。',
        'user_instruction':'保留对方这周忙的原意，不能说对方不想见，不增加下次承诺。'}),
    ('draft-rewrite',{'type':'rewrite_draft','draft_text':'今晚我不参加，祝你们玩得开心。',
        'user_instruction':'保持明确拒绝，不改成犹豫或答应，不增加下次参加的承诺。'}),
):
    cases.append((name,{'contact_id':main,'idempotency_key':str(uuid4()),'content':content}))
atomic_json(root/'followup-cases.json',{'reason':'首次两个回复在外发前被no_active_binding拒绝；补齐真实合成绑定后执行；原409保留。','cases':cases})
pid=json.loads((root/'launcher.json').read_text())['pid']
ports=subprocess.check_output(['lsof','-a','-p',str(pid),'-iTCP','-sTCP:LISTEN','-Fn'],text=True)
address=next(line[1:] for line in ports.splitlines() if line.startswith('n'))
port=address.rsplit(':',1)[1]
for name,body in cases:
    request=Request('http://127.0.0.1:'+port+'/api/reply/generate',data=json.dumps(body).encode(),
        headers={'Authorization':'Bearer synthetic-current-quality','Content-Type':'application/json'})
    try:
        with urlopen(request,timeout=300) as response:
            status=response.status;result=json.load(response)
    except Exception as error:
        if hasattr(error,'read'):
            status=error.code;result=json.loads(error.read())
        else:
            raise
    atomic_json(root/f'reply-{name}.json',{'status':status,'request':body,'response':result})
    print(json.dumps({'reply':name,'status':status,'candidates':len(result.get('candidates',[]))}),flush=True)
