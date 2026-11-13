# 显式归属指导 profile：离线实现结果

> 状态：离线实现及相关完整检查完成；待独立审查，未提交。
> 日期：2026-10-16。依据[已审规格](spec.md)，主 Agent选择先prompt-only，不实现checks。

## 改动与边界

仅既有 `grounded_adapter.py` 增加封闭 `reference-uniqueness-v1` 提示选择。`GroundedV4ExtractionRuntime` 的可选 `prompt_profile` 默认为 `default`；默认返回旧v4提示原字节，新profile只在旧提示后追加规格已审通则，不开放任意提示。未知profile、错误类型及字符串子类构造时拒绝；v2／v3没有此参数，错配先于模型调用拒绝。内部提取路径也拒绝旧版本携带新profile。

原v2／v3／v4默认提示、动态schema、命名工具和全部编译逻辑保持。没有修改factory或运行装配、provider／records／phased、Gold／参考／旧结果、ADR、生产默认、风险／confidence／采纳门或typed；没有新字段、持久schema、runner／harness、依赖、供应商或调用轮次。新增profile尚未绑定任何真实评测身份，当前交付只是离线adapter，不认证可直接用于真实runner。

本片共四文件：上述adapter、既有 `test_grounded_v4_runtime.py`，以及本目录spec和本结果。spec仅更新Root已选路径及已离线实现边界，已审通则逐字保持。旧freeze仍为已关闭历史；不再声称其源码摘要与本片工作树实时匹配。

## 红绿与离线控制

接缝是已授权的公开v4运行时，经实际SDK／HTTPX MockTransport到正式Flow；环境清除真实配置并禁止socket连接和DNS，合成凭据仅用于构造，无真实HTTP或密钥读取。

- 首个 `test_sdk_reference_uniqueness_profile_keeps_captured_unlabelled_a05_auto` 未改源码时真实red：构造器不接受 `prompt_profile`。增加封闭选择后同一测试1／1 green。该red证明新选择尚未接线，不是新的模型质量失败。
- 实际请求包含与已审稿逐字一致的新通则；默认请求的原prompt SHA仍为 `253d66bc5687a8e83f5da31e13cc1f63af07e54d6e61c0800d300dacdddb4ca2`。新旧工具schema和用户输入完全相同。
- 已封A05原参数的同值合成夹具在新旧profile下均仍为无码、0.95及auto，全部facts相等；不读取ignored原件作为测试依赖，不按关键词补码，不用旧matcher救原FULL失败。
- 显式object_ownership＋entity_identity、confidence=1及合成V=supported在新旧profile均pending；给定标签的A15独立读完、A02完整相连问答和明示所有者均保持原可自动采纳模拟去向，facts完全相同。它们只验证编译与门不被提示选择改变，不证明模型会正确选标签。
- 未知／错类型profile及旧v2／v3错配均在构造时失败，传输0。三版本完整140的默认提示与schema均保持变更前固定SHA；既有旧v2／v3给定标签输出字节回归仍保留。

## 实际命令与结果

Python命令均先激活仓库规定的Conda环境，从`backend/`执行，`NOTALONE_DISABLE_DOTENV=1`、`PYTHONPATH=src`：

- 最小red→green单测：1／1通过。
- `python -m unittest tests.unit.memory_extraction.test_grounded_v4_runtime -q`：12／12通过。
- `python -m unittest discover -s tests/unit/memory_extraction -t . -q`：571／571通过，28.800秒。
- `python -m mypy src/notalone/memory_extraction/grounded_adapter.py src/notalone/memory_extraction/grounded.py`：两源文件通过。
- `git diff --check`、本目录链接／本机路径／尾空白核对、源码新提示与spec已审通则逐字核对：通过。无需真实App或GUI来认证此纯提示adapter接线；未声称App端到端通过。

## 数据影响与剩余风险

本轮仅公开合成／Mock，真实API、凭据、预算、业务库、App／微信／GUI及外部发送均0，未创建真实执行身份或自动后继。旧参考、分母和已关闭余额保持。

提示变更不保证模型遵从；原A05失败仍可复现，最近先行词假设没有内部推理证据。本片不提供质量改善、≥15、核心B01／B02、完整140、typed或业务放行信用。后续若定案真实验证，须按规格另固定新合同、源与有限资源，不能将该profile混入旧执行身份。

最终独立Standards／Spec四文件审查均0项需修；主Agent另行复验runtime模块12／12（0.737秒）及差异检查通过。没有因此增加任何真实模型样本。
