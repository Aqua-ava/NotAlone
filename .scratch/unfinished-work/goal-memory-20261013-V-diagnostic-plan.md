# 持续目标：同一公开V载荷的有限技术诊断预注册

前置是[实际基线技术停止](goal-memory-20261013-baseline-result.md)，当前语义基线无效。Root明确同意从总480中尚未启用14预留扣3；原5阶段硬cap466和各UUID保持，baseline余38永久关闭。新唯一run `ca296275-14b8-4be6-baaa-cee6edc58cb5`，硬cap3；另11预留不启用。准备及Mock验证新增真实HTTP0，累计真实尝试仍10。

## 固定载荷与步骤

固定首窗A01在真实基线产生的原E候选，保留其错误标签；恢复原生产thinking enabled的同一V请求，canonical SHA `1ed50f658f1ed61a95bf3eda65b8cf705c516179c5046d105227e3229f72224e`。其余7键、生产V prompt／SourceVerificationOutput schema／工具选择、ECNU endpoint／ecnu-max／temperature0／stream=false不改，不修候选、不改Gold或质量门槛。

按现有真实失败提出有限可证伪假设：①本V请求处理超过原60秒，若SDK180或300秒取得合法结果，则当前观察与超时不足相容；②SDK路径与直接HTTPX路径存在差异，若前两步超时而同载荷HTTPX300取得合法结果，则记录路径差异线索；③服务／固定载荷问题仍持续，若三步均超时或出现非法结果，则保留该技术阻塞。单次时序对照存在服务波动，任何成功都不能单独认证历史根因；不加第四步证伪、不改变原V语义输入。

| 位置 | 启动条件 | 客户端／read timeout | 停止及后继 |
| --- | --- | --- | --- |
| D01 | 本片两轴、Root最终冻结核验与独立预算持久领取完成 | 原ChatDeepSeek／SDK，180秒 | 有效工具及证据契约立即停；仅一个真实尝试的已落盘read_timeout可进入D02 |
| D02 | D01满足上述唯一条件，仍有起发余量且freeze不变 | 原ChatDeepSeek／SDK，300秒 | 有效工具及证据立即停；仅单次已落盘read_timeout可进入D03 |
| D03 | D02满足上述唯一条件，仍有起发余量且freeze不变 | 原HTTPX直接发送同载荷，300秒 | 有效工具及证据立即停；超时后整run关闭，不再补发 |

SDK max_retries=0，transport不自动重试，三位置每个至多1真实发送；重试若意外发生也先消耗持久cap，再被单发送对账拒绝。connect／write／pool各10秒；单步进程内wall alarm为read＋40秒，alarm超时记固定timeout后停，不能冒充read_timeout继续。下一次发起前至少保留read＋45秒，绝对截止台北2026-10-13 02:30（先于原03:00）；没有现存alarm才可进入，退出恢复handler／timer。

任何HTTP错误、非read超时、未知、非法工具或来源证据、opaque脱敏缺口、请求／源码／计划漂移、响应服务型号变化、计数／记录／关闭／收据失败立即停。首个有效V响应只证技术路径可返回受控工具及引用，quality_certified=false；不评分、不自动重开基线或激活reverse／comparison／full_regression。成功早停的后续位置保留unrun，不要求以更多调用填满3。

## 持久与冻结

- 外部工作目录沿用`/private/tmp/notalone-memory-goal-20261013-ac04d687/`0700；`v_diagnostic.py`、`v_diagnostic_selftest.py`、`v-diagnostic-payload.json`与`v-diagnostic-plan-v4.json`均0600。原v1–v3 runner／plan全部保留未运行，不创建旧预算。
- v4 runner SHA `5218c69b1abdd4150a69031886176101789e22a38ed469034f68c706d5555ee7`，bundle canonical SHA `3a1e0e571006341629acfb280bee0f3a7a2d61238449c09d41a2a3234c38f58c`；60份必要源码／公开参考与提交`6ca36359`逐字节冻结，不修改Root当前App组合场次的产品源码。
- 入口及每个发送前复核runner／probe／bundle／固定payload／E片段／原闭账收据／原5阶段总索引／60源；request contract再核7键及当前位置实际HTTP timeout。预算在`/Users/local-user/.notalone-memory-evaluations/<本片UUID>/budget.sqlite3`独立注册，首次持久领取后一次性读取根.env现有3个ECNU键，秘密只在内存中使用。
- 输出另建`v-diagnostic/`，保留预约、每发送、每终态、案例结果、completion及关闭记录；opaque正文不保存，内部思考／headers不回显或提交。store构造到客户端／预算关闭由统一finally覆盖，未知失败保留unknown／unrun；关闭或收据不成立时技术条件不能为true，main失败返回1。

## 最小验证与待核验

初次mypy真实3错（同步／异步client集合与events类型），修后剩1错（循环变量类型复用），随后全部通过；没有把这些类型失败冒称供应商根因。12项严格Mock第一次全绿0.396秒，类型修正后相关12/12全绿0.355秒，真实HTTP0。覆盖SDK180首次有效即停、一次timeout后SDK300、两次timeout后HTTPX300同body、三次timeout有限关闭、JSON／opaque500停止、非法真实片段证据、不允许非read timeout续发、关闭故障拒收据、store构造故障先于凭据且关闭0预算、alarm还原、main失败不返回0。HTTPX／HTTPX2默认transport及socket／DNS全部守卫；夹具只用公开合成窗口，隔离home／计数与临时目录清理。

Spec首审发现真实模式闭账收据读取失败时HTTP上界被误写0：新增公共run边界、精确Mock及关闭读取故障负控，真实red `0 is not None`（0.237秒），改为真实未知None后13/13绿0.396秒。对同一故障继续核查，未读events的响应数也误写0；同负控新增断言真实red（0.232秒），改为事件未核时None。最终13/13、0.372秒及mypy通过，仍真实HTTP0。两个未知计数不以0代签，失败／收据不足仍main1；不改变载荷、UUID、cap、期限或后继条件。当前自检SHA `8a6ca53246243f86ad1debcbb4e9c8627eb1a422b51c6cbdcc25eed0af5bd0de`。

上述为首发前预注册。最终mac Standards硬违反／Fowler判断／证据越界各0，ocr Spec0；二者独立核当前runner／bundle／payload／selftest、60源与6ca blob及权限。Root复核v2→v4仅runner锁变化与480分配后授权唯一启动；[实际V结果](goal-memory-20261013-V-diagnostic-result.md)为首步有效即停且closed，后两步未运行。旧数据、门槛、默认空放行表、真实核心6/12与原未完成验收均保留。
