"""思考模式使用普通终止工具，保持结构核验且不要求供应商强制调用工具。"""
from dataclasses import dataclass
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from langchain.agents.middleware import AgentMiddleware, TracePolicy, omit_payload
from notalone.reply.errors import ReplyInvariantError


@dataclass(frozen=True, slots=True)
class _ReplyOutput:
    payload: dict


def _unique_final_invocation(messages):
    final_calls = [(message, call) for message in messages if isinstance(message, AIMessage)
                   for call in message.tool_calls if call['name'] == 'ReplyRuntimeOutput']
    return (len(final_calls) == 1 and len(final_calls[0][0].tool_calls) == 1)


class ThinkingOutputGuard(AgentMiddleware):
    """在工具执行前拒绝混合/重复提交，不让后续重试掩盖本轮错误。"""
    trace_policy = TracePolicy(process_inputs=omit_payload, process_outputs=omit_payload)

    def after_model(self, state, runtime):
        messages = state.get('messages', ())
        if any(isinstance(message, AIMessage) and any(call['name'] == 'ReplyRuntimeOutput'
                for call in message.tool_calls) for message in messages):
            if not _unique_final_invocation(messages):
                raise ReplyInvariantError('最终候选提交必须是整轮唯一且不混合其他工具的调用。')
        return None


def thinking_output_tool(schema):
    @tool('ReplyRuntimeOutput', args_schema=schema, return_direct=True,
          response_format='content_and_artifact')
    def finish_reply(**payload):
        """提交完整候选并结束本轮；所有候选仍接受正式来源与结构检查。"""
        return '候选已提交核验。', _ReplyOutput(payload)
    return finish_reply


def thinking_output_payload(state):
    messages = state.get('messages', ())
    last = messages[-1] if messages else None
    previous = next((message for message in reversed(messages[:-1]) if isinstance(message, AIMessage)), None)
    calls = previous.tool_calls if previous is not None else ()
    if (isinstance(last, ToolMessage) and last.name == 'ReplyRuntimeOutput'
            and last.status == 'success' and _unique_final_invocation(messages) and len(calls) == 1
            and calls[0]['name'] == 'ReplyRuntimeOutput' and calls[0]['id'] == last.tool_call_id
            and isinstance(last.artifact, _ReplyOutput)):
        return last.artifact.payload
    return None
