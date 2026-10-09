"""真实 LangChain 回调反馈；只有合成 Runnable 输入，不装配外部模型。"""
import json

from langchain_core.runnables import RunnableLambda
from langchain_core.tracers.langchain import wait_for_all_tracers

pipeline = RunnableLambda(lambda text: text.upper()) | RunnableLambda(lambda text: text + "。")
assert pipeline.invoke("synthetic tracing isolation") == "SYNTHETIC TRACING ISOLATION。"
wait_for_all_tracers()
print(json.dumps({"pipeline_completed": True}))
