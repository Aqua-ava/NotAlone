"""主题发布投影的纯组装；评测checkpoint与正式writer共享同一语义。"""
from copy import deepcopy
from datetime import timezone
from uuid import UUID, uuid4, uuid5

from notalone.memory.layered import LayeredMemoryConflict


def scenario_document(row):
    return {"scenario_id": str(row["scenario_id"]), "version_id": str(row["id"]),
            "title": row["title"], "hint": row["hint"], "system_generated": True,
            "updated_at": row["created_at"].astimezone(timezone.utc).isoformat(), "paragraphs": deepcopy(row["paragraphs"])}


def plan_scenario_publication(scope, proposal, previous, budget, *, task_id, batch_id, now, version_id_factory=uuid4):
    """只组装已核验提案；返回持久身份和续接依赖，不宣称已正式发布。"""
    by_id = {row['scenario_id']: row for row in previous}
    replaced_ids = {value for item in proposal['scenarios'] for value in item.get('replaces', [])}
    retained = [row for row in previous if str(row['id']) not in replaced_ids]
    plans, proposed_ids = [], set()
    for scenario in proposal['scenarios']:
        replaced = scenario.get('replaces', [])
        identity = UUID(scenario['scenario_id']) if scenario.get('scenario_id') else uuid5(
            scope.contact_id or scope.owner_id, str(scope.owner_id) + ':' + scenario['topic_key'])
        if identity in proposed_ids:
            raise LayeredMemoryConflict('同批主题身份重复。')
        proposed_ids.add(identity)
        if replaced and identity in by_id and str(by_id[identity]['id']) not in replaced:
            raise LayeredMemoryConflict('主题归组不能覆盖未列为替换目标的旧主题。')
        paragraphs = deepcopy(scenario['paragraphs'])
        prior = None
        if identity in by_id and not replaced:
            combined = by_id[identity]['paragraphs'] + paragraphs
            characters = len(scenario['title']) + len(scenario['hint']) + sum(len(item['text']) for item in combined)
            if len(combined) > budget.max_paragraphs or characters > budget.max_characters:
                identity = uuid5(identity, 'continuation:' + str(task_id) + ':' + str(batch_id))
            else:
                prior = by_id[identity]['id']
                paragraphs = deepcopy(combined)
        row = {'scenario_id': identity, 'id': version_id_factory(), 'title': scenario['title'],
               'hint': scenario['hint'], 'paragraphs': paragraphs, 'created_at': now}
        plans.append({'row': row, 'prior_version_id': prior, 'replaced_version_ids': list(replaced)})
        retained = [old for old in retained if old['scenario_id'] != identity]
        retained.append(row)
    return plans, tuple(sorted(retained, key=lambda row: row['scenario_id']))
