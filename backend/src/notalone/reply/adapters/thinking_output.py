"""思考模式使用普通终止工具，保持结构核验且不要求供应商强制调用工具。"""
from dataclasses import dataclass
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool


@dataclass(frozen=True, slots=True)
class _ReplyOutput:
    payload: dict


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
            and last.status == 'success' and len(calls) == 1
            and calls[0]['name'] == 'ReplyRuntimeOutput' and calls[0]['id'] == last.tool_call_id
            and isinstance(last.artifact, _ReplyOutput)):
        return last.artifact.payload
    return None
