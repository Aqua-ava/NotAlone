# 评测超时及重试显式配置（2026-10-13）

[固定实际V诊断](goal-memory-20261013-V-diagnostic-result.md)在原SDK180秒上限下98.799秒返回有效结果，但原[基线](goal-memory-20261013-baseline-result.md)用写死60秒／2次重试停止。Root允许现有评测工具的最小配置接缝修复，不改产品模型factory、E/V提示、schema、Gold、门槛、默认放行表或业务数据，不靠外部monkeypatch让落盘配置与实际SDK不符。

## 实际变更

- [ECNU公开入口](../../backend/src/notalone/memory_extraction/evaluation_ecnu.py:96)新增关键字`request_timeout_seconds`与`max_retries`，默认60.0／2。只允许内置数值0<timeout≤300且有限、整数0≤retries≤2；bool、字符串、null、NaN、无穷、负值及超界拒绝，失败码固定为`ecnu_invalid_request_limits`。
- 参数核验先于Gold／source／contract、预算创建及凭据加载；先比较范围再isfinite，超大int不会在float转换时意外抛OverflowError。合法timeout统一成float。
- [_frozen_config及共用batch](../../backend/src/notalone/memory_extraction/evaluation_offline.py:159)把同一值写入冻结配置并传给同步／异步HTTPX client和ChatDeepSeek。E/V共用受控模型，实际发送的timeout与持久参数一致；retry均占原持久42硬上限，未添加fallback或新供应商入口。
- P0离线与未传新参数的旧ECNU入口继续60／2。实际生产model factory与CLI不引用此新增接缝。本片不自行启动下个模型阶段或修改已closed计数。

源码评审基点`d488152169ecdbbfd12da563112c89954468c664`包含已完成的日期必需槽修复；本片独立三个代码／测试文件与本记录，不捎带该Flow修改或Root桌面验收工具。

## 真实红绿与最小验证

新增[公开run_ecnu_evaluation的精确Mock E/V接缝](../../backend/tests/integration/memory_extraction/test_evaluation_ecnu.py:140)，固定合成A01返回合法14字段E，V注入read_timeout。原入口不支持参数，首次TypeError红（1项error、0.382秒）；最小实现后同测试绿1.159秒。实际两请求timeout四项均180.0，冻结timeout180／max_retries0，E1响应＋V1失败仅预约2，无SDK自动重试，unknown1/unrun20/quality=false，未用Mock冒称模型语义成功。

下一条公共边界负控覆盖17种非法参数，明确budget.create不得调用；初次超大int在isfinite溢出红（其余控制均通过、0.694秒），调整比较顺序后17控制全绿、0.686秒，凭据／发送／输出均0。原固定21个空E案例另核冻结默认60／2不变。

ECNU及offline两模块完整最小相关35/35通过、4.100秒，失败／错误／skip均0；两源码mypy通过。每条integration fixture清空继承环境、禁止HTTPX／HTTPX2公共及内部默认transport、socket connect／connect_ex及DNS；根.env禁自动加载，只有精确Mock及假凭据、隔离home／临时预算，finally删除临时目录。新增真实HTTP／密钥读取／App／微信／OCR／业务库操作0，目标累计仍11。本片没有为低影响文档运行额外App或全库测试。

后续只做新断言和函数声明的PEP8折行，不改变AST或测试含义；静态反向还原这五处折行并核AST一致，证据为外部工作目录`request-limits-format-check.json`，没有为了格式重复35项。独立mac Standards硬违反／Fowler判断／证据越界各0，ocr Spec0，均只读精确7文件，不代跑HTTP或App；Root已核并释放共享index供主题本地提交，Git历史保存实际提交，无远端Git。

## 后继预算约束

Root已明确选择原未创建的`ae0add54-7f6e-4033-b1e6-37e3a400748f` cap42，另写不可变amendment撤销其reverse用途，改为新的`baseline_after_timeout`，旧index／plan／失败记录全部保留；注册目录不存在的实核与新计划冻结尚待进行。它不是旧baseline余38或V余2，且不再有单独反序42配额，总480不增。新21窗仍需固定Gold、180／0、充足绝对期限与每HTTP起发余量、raw先封存再揭full、两轴和Root末次核验，才能唯一启动。

本修复只让技术参数与证据一致；21窗正式语义audit仍0，指代07／核心01／维度03质量未通过，默认空放行表和真实核心6/12保持。
