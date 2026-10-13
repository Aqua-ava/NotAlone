# 公开评测窗口与新DTO的摘要兼容（2026-10-13）

本片修复原03运行字段变化暴露的评测技术接线。Gold21、公开正文／身份／时间／sender／targets、旧source与两份snapshot、原评分器和旧封存均保持；不签记忆质量或119参考。Root授权后与mac明确文件所有权：本Agent只改四个`evaluation_*`模块及对应四个既有测试，mac继续DTO／Flow／存取／迁移，不写这些评测文件。后继真实场仍须冻结全部实际依赖并同时声明原03及本兼容片，不能归因于仅两个SYSTEM常量。

## 实际失败与最小修复

新`MessageRef`增加`message_type`和`text_representation`，固定公开case实际均为默认`unknown/unknown`。通用`canonical_sha256`按整个DTO规范化，新增字段使原21个input摘要全部失配，Phased构造在预算／凭据之前实际拒绝；私有桥28项首红保留2个布尔旧收据失败和5个入口错误，没有供应商请求。仅诊断去这两个新字段后21／21恢复原Gold；去掉旧snapshot字段不能恢复，第一次诊断0／21也保留。

现有`evaluation_reference`提供唯一命名`public_window_projection`，对象和已序列化窗口经过同一路径：两新槽都缺时保留旧形状；都存在且为真正字符串`unknown/unknown`时，只去掉这两槽；半缺、`text`、`image`、`processed_text`、null或bool均拒绝。消息正文、ID、sender、时间、owner／contact／targets、`source_snapshots`和`message_snapshot`全部保留，不递归忽略同名键。

ECNU及离线计划、Gold21和完整140加载校验、Phased绑定统一使用该投影。运行时窗口和raw／持久case事件仍带两份新元数据；通用规范化函数没有改，完整DTO摘要仍包含新字段。非默认元数据在预算创建／凭据加载／Mock dispatch之前停止，不能无声丢弃已知媒体类型来冒充旧输入。原21／最多4／固定140协议、scope规则、E14／V4、safe-only、全部门槛和默认空放行表不变。

## 运行与证据

证据根目录：`/private/tmp/notalone-memory-goal-20261013-ac04d687/stage-priority-private-checks/`，目录0700／本片log和JSON0600。所有执行先装根.env读取、DNS／socket及两HTTPX真实transport守卫；Mock预算仅在每条测试自有`TemporaryDirectory`的`Path.home`内，真实登记根的open／mkdir／SQLite访问被拒绝。一次`socket.bind`是urllib3导入时的IPv6探测被守卫拒绝，不是连接／HTTP。没有App、微信、真实聊天、供应商HTTP、新真实registry或bundle prepare。

| 记录 | 实际结果 |
| --- | --- |
| `public-window-compat-v1/v2.{log,result.json,status.json}` | 21窗完整DTO0／21；仅移除两个新默认槽恢复21／21。v1误移除四槽0／21保留；两次入口0.718202／0.671651秒。 |
| `projection-red-v1`及`projection-red-restored-tests-v2` | 10个方法实际5fail／6error（含子例）；原参考加载、两计划摘要、预算前非默认拒绝均红，缺命名接口的ImportError单列。首次新增测试插入点把旧断言落到下一方法，已恢复原方法后再红，不计产品缺陷。第二入口1.664330375秒。 |
| `projection-first-green-v1` | 9项过／1新测试错误：deepcopy包含unittest绑定方法，触发TextIOWrapper不可拷贝；仅复制实际要改的window后修夹具，原日志保留。 |
| `projection-green-v2` | 10／10，内层2.251743秒／入口3.843601541秒／exit0；覆盖21输入及E/V格式、元数据半缺／非默认、core／旧snapshot漂移、legacy shape、raw元数据与预算前停止。 |
| `projection-four-modules-v1` | 四个最小相关unit／integration模块79／79，unittest18.203秒／入口18.934814041秒／exit0；包含原完整140结构Mock，不认证119中文参考。 |
| `projection-mypy-four-v1` | 四个源文件mypy成功，检查1.674331833秒／入口2.444439208秒。 |
| `projection-text-proof-v1` | 原21 inputSHA全部一致，实际E格式文字21／21及V格式文字21／21前后逐字一致；完整DTO通用摘要仍21／21不同，运行时新元数据仍在。入口0.550947500秒。 |

E/V文字证据由正式`_window_text`和`_verification_text`格式函数直接生成；V使用每窗相同的固定非空合成candidate控制，未读取旧provider内容、未假称21个真实模型响应。JSON只保存摘要和布尔，不保存聊天正文。原Gold文件仍为`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`；一般规范化没有排除新增字段。

每条运行的173路径草案快照前后均无漂移；这只绑定当次测试，不是原03整体稳定证明，不是最终全部依赖冻结。四源及四tests已停止编辑，实际SHA与固定差分另见私有`public-window-projection-review-metadata-v1.json`；Root协调两轴与只含本主题的本地提交，当前本片尚未提交。

## 未完成范围

模型真实尝试仍59／十stage closed，55个200及4个旧ReadTimeout远端未知分列。关闭未用171与退役12不复用，full280未注册，fresh8仅已有有限预注册；此片不授权注册或调用。原三票保持各自State及未满足验收，A08旧full unknown不补签，119全部参考仍未完成。私有fresh8桥还须接同一投影、保留真实Phased校验并重新完成相关Mock／类型及最终依赖冻结；原03稳定后才由Root独立末核是否唯一启动。
