"""显式审核输入经既有回复上下文与运行时产生同输入对照。"""

from contextlib import nullcontext
from dataclasses import asdict, replace
from uuid import UUID

from notalone.reply.adapters.skill_preview import ReplySkillPreviewEngine
from notalone.reply.adapters.skill_review_calls import SkillReviewCallLedger
from notalone.reply.interface import GenerateReply, NoSkill, RewriteDraft, UserSkillChoice
from notalone.reply.errors import ReplyContextError
from notalone.scopes import VerifiedConversationScope
from notalone.skills.draft_view import ReadOnlyDraftSkillPort
from notalone.skills.learning import SkillLearningInvalid, content_digest
from notalone.skills.models import SkillCatalog


class SkillReviewService:
    """业务状态持久等待；模型只持有本次隔离只读视图。"""

    def __init__(self, *, store, context, binding_lookup, skills, runtime_factory,
                 ledger, model_name, priority=None):
        self.store, self.context, self.binding_lookup = store, context, binding_lookup
        self.skills, self.runtime_factory, self.ledger = skills, runtime_factory, ledger
        self.model_name, self.priority = model_name, priority

    def read(self, scope, draft_id):
        return self.store.read(scope, draft_id)

    def edit(self, scope, **command):
        return self.store.change(scope, **command)

    def decision(self, scope, **command):
        return self.store.change(scope, **command)

    def approve(self, scope, **command):
        return self.store.approve(scope, **command)

    def compare(self, scope, **command):
        input = command['input']
        binding = self.binding_lookup(scope.owner_id, scope.contact_id)
        if binding is None:
            raise SkillLearningInvalid()
        # 此文字是用户为审核明确提供的输入，不创建消息、发送或事实凭证。
        reply_command = GenerateReply(idempotency_key=command['operation_key'], scope=scope,
            conversation_binding_id=binding.binding_id,
            content=RewriteDraft(input['incoming_text'],
                '审核演示输入，不证明收到或发送。用户本次明确意图：' + input['intent'], True),
            skill=NoSkill(), scene=input['scene'])
        context = self.context.build(command=reply_command,
            verified_scope=VerifiedConversationScope(scope.owner_id, scope.contact_id, binding.binding_id))
        self.context.validate_current(context)
        fingerprint = context_identity(context)
        dependencies = set()
        for item in context.evidence:
            if item.kind not in ('user_draft', 'user_purpose'):
                dependencies.add(item.evidence_id)
            dependencies.update(item.source_ids)
            if item.navigation is not None:
                dependencies.update(item.navigation.dependency_ids)
        for item in context.style_references:
            dependencies.add(item.sample_id)
        for item in context.expression_preferences:
            dependencies.add(item.preference_id)
            dependencies.update(item.source_ids)
        revisions = {'library': context.skill_library_revision, 'memory': context.memory_revision,
                     'index': context.index_revision, 'preferences': context.expression_preference_revision,
                     'binding_id': str(binding.binding_id)}
        draft, comparison, replay = self.store.begin_comparison(scope, **command,
            context_fingerprint=fingerprint, context_dependencies=dependencies, context_revisions=revisions,
            navigation=[{'scope_kind': item.navigation.scope_kind,
                         'memory_id': str(item.navigation.memory_id),
                         'memory_revision': item.navigation.memory_revision,
                         'dependency_ids': sorted(str(value) for value in item.navigation.dependency_ids)}
                        for item in context.evidence if item.navigation is not None])
        if replay:
            return self.store.read(scope, command['draft_id'])

        def validate():
            if self.priority is not None:
                self.priority.check_running()
            try:
                self.context.validate_current(context)
            except ReplyContextError:
                raise SkillLearningInvalid() from None
            self.store.validate_comparison(scope, comparison['id'], comparison['run_token'], fingerprint)

        try:
            with self.priority.foreground() if self.priority is not None else nullcontext():
                validate()
                execution = self.store.validate_comparison(scope, comparison['id'], comparison['run_token'],
                    fingerprint, with_execution_view=True)
                scoped_skills = self.skills.for_scene(input['scene'])
                before_catalog = scoped_skills.catalog(scope)
                targets = draft['target_versions']
                entries = tuple(entry for entry in before_catalog.entries
                                if targets and str(entry.version_id) == targets[0]['version_id'])
                before_catalog = SkillCatalog(scope, before_catalog.revision, entries)
                before = self._generate(scope, context, scoped_skills, before_catalog,
                    comparison, 'before', UserSkillChoice(entries[0].version_id) if entries else NoSkill(), validate)
                validate()
                draft_port = ReadOnlyDraftSkillPort(scope=scope, draft=draft, comparison=comparison, validate=validate,
                    execution=execution)
                after = self._generate(scope, context, draft_port, draft_port.catalog(scope),
                    comparison, 'after', UserSkillChoice(comparison['id']), validate)
                validate()
                if after.load_state != 'loaded' or after.version_id != comparison['id']:
                    raise SkillLearningInvalid()
                return self.store.finish_comparison(scope, comparison['id'], comparison['run_token'],
                    fingerprint, {'before': preview_payload(before), 'after': preview_payload(after)})
        except Exception:
            try:
                validate()
            finally:
                self.store.fail_comparison(scope, comparison['id'], comparison['run_token'])
            raise

    def _generate(self, scope, context, port, catalog, comparison, side, choice, validate):
        accounting = SkillReviewCallLedger(scope=scope, ledger=self.ledger, model_name=self.model_name,
            validate=validate, record_call=lambda entry_id: self.store.record_call(scope, comparison['id'], side, entry_id))
        engine = ReplySkillPreviewEngine(port=port,
            runtime_factory=lambda single: self.runtime_factory(single, accounting))
        prepared = replace(context, command=replace(context.command, skill=choice))
        return engine.generate(scope=scope, context=prepared, catalog=catalog)


def context_identity(context):
    evidence = []
    for item in context.evidence:
        value = asdict(item)
        if item.kind in ('user_draft', 'user_purpose'):
            value.pop('evidence_id')
        evidence.append(value)
    return content_digest({'text': context.current_text, 'evidence': evidence,
        'binding': context.command.conversation_binding_id, 'scene': context.command.scene,
        'library': context.skill_library_revision, 'memory': context.memory_revision, 'index': context.index_revision,
        'styles': [asdict(item) for item in context.style_references],
        'preferences': [asdict(item) for item in context.expression_preferences],
        'preference_revision': context.expression_preference_revision})


def preview_payload(preview):
    return {'name': preview.name, 'version_id': str(preview.version_id) if preview.version_id else None,
            **({'execution_view': preview.execution_view.to_payload()} if preview.execution_view else {}),
            'load_state': preview.load_state, 'candidates': [
                {'text': item.text, 'basis': item.basis, 'risk_notes': list(item.risk_notes)}
                for item in preview.candidates]}
