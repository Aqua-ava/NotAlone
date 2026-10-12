# 记忆提取日期槽结构拒绝修复（2026-10-13）

承接[运行字段及原红反馈](goal-memory-runtime-fields-20261013.md)、[原03票](../memory-accuracy-next/issues/03-per-dimension-rollout.md)与[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)。Root在新V诊断已闭账、剩余App组尚未启动时解除60份源码冻结，明确授权本最小修复；新的四类结构化依据、ADR／DDL／Gold／放行表均未修改。

## 问题与实际修复

[生产E schema](../../backend/src/notalone/memory_extraction/adapters.py:245)要求`valid_at`和`invalid_at`都出现，允许显式null。原[mapper两处get](../../backend/src/notalone/memory_extraction/flow.py:438)把缺键也当null，完整语用标签下可产生subject维度候选。原最小合成探针已发现三个缺槽负控均被接纳；默认空放行表仍拒绝自动采纳，未观察到错误auto或业务写库。

本片只将两处日期读取改为直接索引。缺任一必需键由现有[Flow解析失败路径](../../backend/src/notalone/memory_extraction/flow.py:135)记`structure_rejected`，增加`rejected_count`且不进入来源／核验／采纳。显式null继续交给原`_as_datetime`解析；日期格式、语用、时间优先、0.7与风险白名单、默认空表均保持。现有候选和来源不回填、不删除，不迁移数据库。

源码基点`e337445a134c5b36421c2e36812e94fcfa7bce1c`；实际Flow修改前SHA `626e76d90ac0a48480711e9928734afb502e1d0977834288bd68688380c77bbd`，修改后SHA `0b864558a8c289bfaee362df30756f8b1f9371263983375bd6d8f56f16a6a152`。相关回归时[公开Flow测试](../../backend/tests/unit/memory_extraction/test_flow.py:357)SHA `3c1c63241158fa6cff712b24e4b03555595584984cf332d13793830d5e413d8c`；随后只将86列函数声明按PEP 8折行，最终SHA `41a1b24cd6e59327dfe7b51f4c395e1e92a6a06aab38130b602a175179fc8043`，前后Python AST去位置属性完全一致，核对记录为私有`format-check.json`。

## 真实红绿与相关回归

测试接缝是Root明确指定的公开`ExtractionFlow.run`，外部E／V边界只用既有确定性合成runtime及来源oracle，后者不证明模型语义能力。新增负控逐一去掉valid_at、invalid_at及两者；新增正控分别覆盖完整14字段的explicit-null assertion、explicit-null correction、report／reported带日期。断言候选接受／拒绝及计数、维度与语用分流、默认不放行，不测试私有mapper实现。

| 实际阶段 | 结果 | 进程内整体单调时长 |
| --- | --- | --- |
| 公开Flow负控首红 | 1方法、3个缺槽subcase失败、errors0；均返回候选 | 0.074298秒 |
| 两行修复后的同一负控 | 1/1方法通过、3个缺槽均拒绝 | 0.045787秒 |
| Flow／维度／采纳最小相关组 | 59/59通过，failures／errors／skip均0；包含3个完整字段正控 | 0.081334秒（unittest本体0.004秒） |
| 单Flow模块mypy | `Success: no issues found in 1 source file` | 1.817158秒 |
| 原六例结构探针固定脚本回放 | 4方法／6case，4/4通过；3个完整控制及3个缺槽拒绝均绿 | 0.049050秒 |

以上每阶段使用Conda NotAlone／Python3.12；仓库外校验器清空环境、禁dotenv，拒绝socket／DNS及HTTPX／HTTPX2默认transport，60秒硬上限。原六例脚本使用其既有30秒上限，原SHA `382b421ac810f8798056d1f6ac2a9c5b56cff9a68357514f450414fb09167604`逐字节复制到新目录，计划与结果另写，原红和初始化失败保持不变。各阶段网络及dotenv守卫尝试0，新增真实HTTP／模型调用／App启动／业务库写入／秘密读取均0；采纳单测只用内存存储。没有运行全库、模型重评或桌面场。

一次修复工具调用错误使用不存在的`_optional_datetime`上下文，apply_patch未匹配、未改文件也未运行绿测试；读实际`_as_datetime`后完成两行修复。该工具失败与首红保留，不当成产品根因或成功。新正控为首运行即绿，不伪称它们曾红。

实际入口均在`backend/`，先激活Conda NotAlone：

```text
python /private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/validation.py red
python /private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/validation.py green
python /private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/validation.py minimal
python /private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/validation.py mypy
python /private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/replay/date_slots_probe.py
```

校验器只接受上述四个固定stage；minimal展开为`tests.unit.memory_extraction.test_flow`、`test_dimensions`、`test_adoption`，mypy只显式检查产品Flow模块。每阶段日志／结果独占写入，不能覆写旧记录。

## 证据、资源与验收边界

私有合成证据目录`/private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/repair/`为0700：`validation.py`、`red.json/log`、`green.json/log`、`minimal.json/log`、`mypy.json/log`均0600；`replay/`0700，固定脚本／plan／result／green-output.log均0600。只含公开合成夹具、结构结果和源码摘要，未读取获准projection之外的模型原输出、聊天、身份或密钥。进程均已退出，首红exit1与其余exit0分别保存，无App／后端／CLI常驻；证据及mypy私有缓存为复核保留。

本修复完成必需日期槽的确定性结构回归，不提供新语义基线、真实核心6/12或任何维度放行证据；四类typed缺口及原03 AC1仍未关闭。关闭的模型run及余额不重用，默认放行仍为0。最终App组合及实际OCR／微信证据由Root另记。

最小文档核查：Conda NotAlone标准库核7处本地引用／行号有效、repair／replay为0700、所有直接证据文件0600、复制probe与原字节SHA一致；无行尾空白、有结束换行。`git diff --check`无问题；新文件`git diff --no-index --check /dev/null`无输出，exit1仅表示新文件差异。

独立mac Standards与memory Spec均只读最终三文件及所需合成证据，硬违反／Fowler判断气味／missing／scope／error／证据越界均0；两轴没有运行代码、App或模型，也没有读取秘密。主题独立本地提交等待Root共享index时段；本片不执行远端Git。
