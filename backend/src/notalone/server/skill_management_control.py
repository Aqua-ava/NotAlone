"""仅认证宿主控制的Skill交接；停收排空后一次激活，不恢复本地写入。"""
import threading
from uuid import UUID
from notalone.persistence.skill_management_handoff import skill_management_handoff, SkillManagementUnavailable
from notalone.persistence.skill_management_remote import RemoteSkillManagement

class SkillManagementControl:
    def __init__(self, owner_id):
        self.owner_id = owner_id
        self.remote = None
        self.lock = threading.Lock()
        self.closed = False
        self.owned = False

    def handle(self, action, method, payload):
        with self.lock:
            if self.closed:
                raise SkillManagementUnavailable('Skill 管理已关闭。')
            if action == 'status' and method == 'GET':
                return skill_management_handoff.status()
            if action == 'stop' and method == 'POST' and payload == {}:
                self.owned = True
                return skill_management_handoff.stop()
            if action != 'activate' or method != 'POST' or not isinstance(payload, dict) or set(payload) != {'owner_id', 'port', 'token'}:
                raise ValueError('skill_management_request_invalid')
            if self.owner_id is None or str(self.owner_id) != payload['owner_id']:
                raise ValueError('skill_management_owner_mismatch')
            owner = UUID(payload['owner_id'])
            remote = RemoteSkillManagement(port=payload['port'], internal_token=payload['token'], owner_id=owner)
            try:
                result = skill_management_handoff.activate(owner_id=owner, synchronize=remote.synchronize)
            except Exception:
                remote.close()
                raise
            self.remote = remote
            return result

    def close(self):
        with self.lock:
            self.closed = True
            if self.owned:
                skill_management_handoff.stop()
            if self.remote is not None:
                self.remote.close()
