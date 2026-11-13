"""离线重放已捕获输出；不调用模型、不访问业务库。"""
import argparse
import json
from pathlib import Path
from notalone.memory_extraction.flow import _to_fact
from notalone.memory.personal_organization import verify_result
from notalone.memory.organization_quality_suite_budget import atomic_json

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();root=args.output
calls=json.loads((root/'calls.json').read_text())
results={'fact_parse':[],'organization_verification':[],'calls_by_effective_phase':{}}
for call in calls:
    request=json.loads((root/f'request-{call["index"]:03}.json').read_text())
    response_file=root/f'response-{call["index"]:03}.json'
    if not response_file.exists():continue
    response=json.loads(response_file.read_text());message=response['choices'][0]['message']
    tools=[t.get('function',{}).get('name') for t in request.get('tools',[])]
    phase=('reply' if 'ReplyRuntimeOutput' in tools else
           'l1_adjudication' if 'BatchMemoryAdjudicationOutput' in tools else
           'l1_extraction' if 'DirectMemoryExtractionOutput' in tools else call['phase'])
    results['calls_by_effective_phase'][phase]=results['calls_by_effective_phase'].get(phase,0)+1
    if 'DirectMemoryExtractionOutput' in tools:
        for tool in message.get('tool_calls',[]):
            if tool['function']['name']!='DirectMemoryExtractionOutput':continue
            payload=json.loads(tool['function']['arguments'])
            for scene in payload['scenes']:
                for index,row in enumerate(scene['memories']):
                    item={'call':call['index'],'stage':call['stage'],'scene':scene['scene_name'],'index':index,'text':row['text']}
                    try:
                        _to_fact({**row,'_requires_all_sources':True})
                        item['parse']='accepted'
                    except Exception as error:
                        item.update(parse='rejected',error_type=type(error).__name__,error=str(error))
                    results['fact_parse'].append(item)
    if call['phase'] in {'l2_verification','l3_verification'}:
        try:
            human=json.loads(next(m['content'] for m in request['messages'] if m['role']=='user'))
            payload=json.loads(message['content'])
            if 'items' in payload:
                decision=verify_result(payload,human['proposal'],human['memories'],call['phase'][:2],human.get('corrections',()))
                results['organization_verification'].append({'call':call['index'],'stage':call['stage'],'decision':decision})
        except (KeyError,ValueError,TypeError) as error:
            results['organization_verification'].append({'call':call['index'],'offline_replay_error':type(error).__name__})
atomic_json(root/'offline-diagnostics.json',results)
print(json.dumps({'phases':results['calls_by_effective_phase'],'parse_rejections':[
    r for r in results['fact_parse'] if r['parse']=='rejected'],'organization':results['organization_verification']},ensure_ascii=False))
