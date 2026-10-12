# 单次公开A02核验提示控制预注册（2026-10-13）

Root允许准备一个新单V语义控制：只消耗原reserve最后1次，不启动E、不重开八个closed stage、不恢复旧成绩，不证明E提示收益或原质量验收。当前累计实际HTTP42次（38次200、四次旧ReadTimeout远端结果未知），全量280未启用，关闭未用145与永久退役12均不能挪用。本计划仍待两轴和Root最后首发冻结；准备阶段真实HTTP及预算注册0。

唯一新UUID为 `472f5c0d-7a7e-4620-9586-1698f76b7d97`，硬cap1，无SDK重试、fallback、第二请求或自动后继。新不可变 `goal-budget-amendment-v6.json` 仅把v5的reserve1改为本控制1，剩余reserve0；完整allocation仍480。v1–v5及原总索引、八份closed收据、所有失败／未运行保留，均不覆盖。

## 固定输入与唯一变量

输入取自已closed的四窗公开合成run `86b6a718-b1e4-4203-8f74-27a38f297987`：A02唯一V请求，原局部位置1、request_sequence4。原body规范SHA为 `6c42631633e9f5b03b3731bc7e4944f2bdd1b81e191314ee689e05b7b783bda5`；原E-only视图规范SHA为 `eb6e6e95bde5a1e0792cb1bc4f4beed4a29bfdb5524035d91e1abd30aaf208c5`，其中一条完整E14保持。window、正文、人物、source顺序、双null时间、具名工具schema、模型、temperature、stream和thinking均不改变。

唯一变化是 `messages[0].content`，使用已独立提交 `4c939d965c1d9f3cf3c8c3229914b3ea8edf1f67` 的V system prompt；prepare把替换后的system反替回原值后，整body必须与原请求相等。新payload规范SHA为 `2b700cfa3816174f87223b6058c489a3891bf9d16129293b3c053b03f09cbda4`，固定输入规范SHA为 `0120f946cc790a9eb30bb1a4fba64463fcda9e5421ded3eaaf212c0bec22e633`。这是对原14/14 E输入的V控制，不能称新E产物或全量A/B。

原Gold21文件字节SHA `5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`、规范对象SHA `5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32` 保持；A02历史邀约和未来活动的分层原判据保持。不会修改旧封存review、uncertain/pragmatics失败或任何full分数。

## 场次与运行接缝

Root已选定最终未激活场次台北06:30至07:00（2026-10-13），最后HTTP起发界线06:44:15，等于07:00减300秒调用、600秒审核和45秒余量。06:40至07:05只是较早未激活草案，保留记录，不用于执行。若两轴／Root核验结束时已错过起发门，则保持0注册／0HTTP，不滚动窗口或更换UUID补位。

仅新私有 `v_semantic_control.py`、其selftest、固定input／plan／amend-v6和本文；不修改产品源或接口。复用原 `EvaluationBudget`、持久 `EvaluationRecordStore`、精确 `ECNUEvaluationContract.expect_request`、`ChatDeepSeek` 与正式 `LangChainSourceVerificationRuntime`。SDK和两个HTTPX client的connect/read/write/pool均300秒，SDK重试0，受控transport在每次真正dispatch前预约计数。prepare不领预算或读密钥；run核新注册缺席与场次余量后才create cap1，在batch持锁后用原根.env受控loader，不回显秘密。

绝对SIGALRM覆盖batch、调用、审核和client／budget finally；API另在同一自有handler上夹340秒墙钟上界，结束后恢复绝对剩余时间，拒绝覆盖已有alarm。generic墙钟超时不被称为read_timeout或允许补发；任何异常均停止，原始HTTP计数／未知与未完成保留。读取时限不等于SDK总墙钟，二者分别记录。

合法具名V工具及来源片段契约通过后，保存不含思考的 `V-semantic.view.json`：原公开window、旧E14、实际V输入、四字段输出、原A02参考及摘要。由Agent在独占 `.review.json` 显式给四字段和语义支持分别pass/fail/unresolved；没有默认pass。600秒clock在写view前记录阶段起点，包含保存耗时；读前／读后再次核阶段及绝对截止，最后sleep后迟到也拒签。来源支持只表示忠实保留原话，不证明现实世界真假。

完整正确仅记录本次单V控制safe；普通字段／语义失败可正式记录general_error，不能签控制通过；未决、缺／晚review、非法工具／证据、来源或payload漂移、存储／计数／清理未知立即停止。无论结果均不签quality、维度放行或旧质量票完成。主入口不完整或清理／收据不可靠exit1，计数无法核实时为null，不能写0真实调用。

## 固定证据与准备验证

私有证据根 `/private/tmp/notalone-memory-goal-20261013-ac04d687/` 为0700，本片文件0600。首版bundle规范SHA `1cee933634ddf01baa91f69be860c473656985591048dc9fcb857d51dc783377`，runner文件SHA `86e30ca3925271f7f68bd31cde1ff3ba886589b415412f6048f4e0326dc96346`；其他摘要见 `v-semantic-control-plan-v1.json`。freeze绑定当前4c939d96全部60源码／Gold文件、八个安装版本、原request／E视图／Gold及八closed收据，发生漂移在真实起发前拒绝。

准备selftest先14/14首次绿（内部0.635秒、工具外层2.374475秒），没有虚构red；补真正时钟边界与真实模式计数unknown负控后16/16绿（内部0.729秒、subprocess外层1.624725416秒）。所有注册只在临时HOME，SDK回复由精确MockTransport生成，真实socket／DNS／HTTPX默认transport禁止；真实供应商HTTP和App均0。

覆盖唯一dispatch／300秒／零retry、read_timeout不补发、非法来源证据、普通语义失败与完整控制分开、source漂移与注册前拒绝、实际FROM前／最后起发界线／总deadline边界及其正控制、UUID不可复用、缺或未决review、最后sleep后晚到、client／store故障、收据无法核时真实模式计数null、已有／自有alarm恢复，以及失败主入口不能exit0。闭账unknown分支虽设置real模式摘要，实际传输仍注入精确Mock，不能计为真实HTTP。

原14项日志为 `v-semantic-selftest-first.txt`，最终16项与外层实际收据为 `v-semantic-selftest-final.txt`、`v-semantic-selftest-final.status.json`。prepare实际exit0、源码60、未调用／未注册；不把准备成功替代真实V语义。Root最后核验并明确首发后，唯一命令为 Conda NotAlone 下 `python /private/tmp/notalone-memory-goal-20261013-ac04d687/v_semantic_control.py run --bundle-sha <最终冻结摘要>`。当前尚未执行run。
