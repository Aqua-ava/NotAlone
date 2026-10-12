# 持续同步验收接缝补齐（2026-10-13）

承接 [04 原票](../native-app-backend/issues/04-real-wechat-follow-smoke.md)及[本目标](continuous-goal-20261013.md)。用户本聊天仅明确授权一位测试联系人，每位最多12条固定测试文字；第二位未确认，不从历史任务或昵称推定。当前实际来信、长时同步、App、OCR验收均尚未运行。

## 最小修复与验证

原 `real-sync-python.py` 验收范围默认只有30分钟且拒绝对方消息，无法承载本次60分钟测试。新增两个仅验收工具使用的可选Boolean：`long_running` 明确声明才允许最多4500秒；`allow_incoming_test_text` 明确声明才允许同一已确认会话的约定来信文字。省略时保持原1800秒、仅我方文字；产品运行时没有新增发送或读取能力，App `test:app` 的一小时租约上限不变。

来信仍须通过稳定会话标识、固定正文白名单、时间边界、文字类型、有效来源和已观察游标校验；不改写 `is_from_me`，之后必须单独计数真实方向。我方发送不能冒充来信。未知字段、非法Boolean、75分钟以上窗口、未确认会话、媒体、未约定正文、越界或未知游标仍整批拒绝。

在 Conda `NotAlone`、backend/ 运行：

```bash
NOTALONE_DISABLE_DOTENV=1 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false \
python -m unittest tests.unit.wechat_cli.test_acceptance_scope -v
```

- 首次14项：两个新增行为真实红，原12项绿（参数尚缺、scope新字段被拒绝）。
- 修改后：窗口门绿；来信负控首次失败，原因是测试用 `str.replace` 试图替换默认Unicode转义后的JSON，未实际改到文字。保留失败记录，改为解析对象后修改字段。
- 最终 **14/14通过**，unittest 0.117秒，命令0.773秒。全部合成，无真实CLI/模型/App/OCR或业务库调用。
- 独立 Standards（mac_provenance）：硬规范0、代码气味0；Spec（ocr_repair）：0项。两轴核对默认行为、显式长时门、真实方向、白名单及原截止/私有文件/来源/游标保护。未以合成通过勾原票真实AC。

## 当前桌面与身份预检

主Agent通过Computer Use正式微信路径核对当前已获授权会话的标题与选中行，未发送。CLI只读 `resolve-chat` 两次：首次把模糊搜索的10候选误当应唯一而停止；第二次保留错误口径后检查，唯一精确显示名的私聊候选与本聊天确认和当前UI一致。其他候选元数据已从自有证据清除，仅存计数；没有读取消息正文。旧sandbox误选到canary写目录时在任何CLI调用前被本轮断言拒绝，随后复用最终包只读策略，仅允许写 `/dev/null`、禁止网络。

私有范围目录为忽略的 `desktop/artifacts/goal-sync-20261013-rf05wl3f/`，0700；身份/解析/策略0600，不提交联系人身份、截图、原始正文或游标。当前preflight真实CLI元数据查询2次，正文0、发送0。后续场次必须另登记实际起止/检查点，结果据当场计数更新。
