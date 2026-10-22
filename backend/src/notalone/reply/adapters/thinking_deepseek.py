"""已锁定 SDK 的思考字段回传适配；输入计量与实际发送共用同一序列化。"""
from langchain_core.messages import AIMessage
from langchain_deepseek import ChatDeepSeek


class ThinkingDeepSeek(ChatDeepSeek):
    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        messages = self._convert_input(input_).to_messages()
        if len(messages) != len(payload['messages']):
            raise ValueError('思考字段回传无法绑定原始消息顺序。')
        for message, encoded in zip(messages, payload['messages']):
            if isinstance(message, AIMessage) and 'reasoning_content' in message.additional_kwargs:
                reasoning = message.additional_kwargs['reasoning_content']
                if not isinstance(reasoning, str):
                    raise ValueError('供应商思考字段必须为文字。')
                encoded['reasoning_content'] = reasoning
        return payload
