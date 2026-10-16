# v6 Finder／TCC与v9实体快捷键分项结果

日期：2026-10-16，以下时刻均为UTC。结论：**v6 Finder独立启动场1／1通过，录屏责任归属取得同实例实证；v9实体快捷键场1项失败，首次显示有人报及瞬时程序观察，第二次隐藏未认证。** 两场各启动一次，不能合成同一版本完整交付，也不改变原18／20票的State或AC。

## 版本、隔离与原件

共同协调runId为`6fc04721-d6db-4c77-b573-bd0c2a77e5cd`，原件仅存忽略目录`desktop/artifacts/gui-permission-keyboard-20261016-6fc04721-d6db-4c77-b573-bd0c2a77e5cd/`。目录内保留scope、有限租约协调器、各场run.log／owned／退出收据、权限操作收据、TCC固定字段投影和独立清理检查；不提交原始UI、私人显示名、聊天或截图。

| 项目 | v6 Finder／TCC | v9实体快捷键 |
| --- | --- | --- |
| 包目录（仓库相对） | `desktop/artifacts/remaining-nine-final-20261016-v6/NotAlone-darwin-arm64/NotAlone.app` | `desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app` |
| ASAR SHA-256 | `7ed7f0c34f5c059cc848c59e2e6e0bfffb72fd61680fc781be8f7a43d9c3cd27` | `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021` |
| 核心库SHA-256 | `87186371e040c901ff6018eb9e7af830ca23236bcbb437555195d6733cfcbcf9` | `c17f9028c8a90fd8c8e44d26953b5d9b4ce18d72715ed7ff1308262b030724c2` |
| 18源`manifest.buildSourceDigest` | `ddc1a10672c82903f86a05f3ae02ceb15cc4246b559e4301d1791151aae3f8d1` | `8b3df06a118fb851bb06e509cece191c92b5d100eb7a5e8598db115948cf79bf` |
| 主包deep／strict签名 | exit0，ad-hoc、无Team | exit0，ad-hoc、无Team |
| 业务环境 | 随机隔离PG、整体暂存／恢复默认userData，合成空读取授权 | 独立临时userData、空启动配置，后端未配置 |

两包正式探针SHA-256均为`d945ff34a1bc8745bd17eb55742312e02156093be02e88f967ecc21d389a9de7`，独立顶部源可执行文件均为`28cb8b9260316b681f2e0dcbf931dd9db7401fc6563ac6fc048ae66aafc56218`。App、正式探针、独立源identifier分别核为`com.notalone.desktop`、`com.notalone.sync-probe.cli`、`com.notalone.sync-probe.header-change`。这些静态检查不能单独证明TCC责任或系统按键送达。

v6禁用真实CLI：路径指向本轮不可用适配器；模型key为空，端点为不可用回环地址，无业务导入／生成／记忆worker调用。v9未配置后端，不启动CLI、探针或模型。两场外部模型请求、真实CLI调用及聊天发送均为0；没有读取凭据或新增联系人正文范围。

## v6：用户认证后完成同包Finder独立权限核验

旧[Finder失败](finder-native-permission-20261015.md)的45秒未捕获原生PID和随后两次`screen_capture_permission_missing`保持失败。本轮没有改写旧结果，也没有把Codex祖进程准入当作App权限。

Computer Use实际查看“录屏与系统录音”：开始只有旧NotAloneApp已开启，当前Electron NotAlone没有对应条目。新增流程出现本机认证表单后由用户本人完成认证；Agent未输入密码或生物认证。收到新的明确完成反馈后，Agent在系统文件选择器中选择本轮已校验的精确v6包并点击打开，实际看到新增NotAlone条目为on，旧条目未改。`v6-permission-action.json`明确记录本场发生权限变化；不能把最初scope里的零权限变化准备状态当成最终事实。

随后Agent从Finder实际打开该v6 App，App由LaunchServices启动、父进程为1，非Playwright的Electron启动。夹具只负责准备整体隔离配置、鉴权后端及量测；`finder-launch-action.json`记录实际Finder动作。Agent实际开启空授权范围的同步、隐藏管理窗口、将微信置前并执行微信“隐藏其他”。没有执行“显示全部”。

45秒观测取得260次进程快照：10个正式`--single-frame`探针PID、1个独立顶部源PID；119次快照含该源。legacy session与未知参数PID均为0。这是尝试与进程存在性计量，不是10次成功OCR或连续源覆盖认证。夹具的`nativeCaptureSuccessCertified`、`tccAttributionCertified`、`identityCertified`、`streamCoverageCertified`仍按原设计保持false，没有修改夹具补签。

同一存活Finder实例的额外鉴权公共`POST /api/sync/foreground/observe {}`于04:43:52.737Z返回HTTP200、`phase=paused`、`reason=group_chat_suspected`，不再是旧`screen_capture_permission_missing`。仅保存固定状态、原因及键集合，没有保存响应中的身份或文字。实际微信处于群聊边界，不能拿该结果认证私聊A名称、绑定或可生成。后续Agent实际使小窗可见并获焦，界面显示前台定位暂停说明、联系人未确认且生成禁用；该UI观察不能替代本场未执行的真实CLI独立性量测。

本机TCC只读日志的`AUTHREQ_ATTRIBUTION`按本场App进程身份过滤后，responsible为`com.notalone.desktop`，accessing分别为正式探针和独立顶部源，不是`com.openai.codex`。10个已采样正式探针PID和1个源PID各对应2条归属行，共20＋2条，均匹配同一个Finder App责任PID。整个App存活时段共102条匹配归属行（正式96、源6），已包含上述20＋2条；预检可能重复产生行，不能把102行当作102次采集或调用。归属检查见`finder-v6/tcc-attribution-check.json`与`tcc-owned-attribution.json`。系统条目on、公共观察固定群聊暂停及准确归属是分开的证据，不把归属行本身等同所有授权决策成功。

Agent从NotAlone公开菜单实际点击退出。用例**1／1通过，报告5.3分钟，runner code0／signal null，04:46:14.231Z完成**。正常退出、App／后端／原生退场、握手消失、原默认userData整体恢复和清理均有收据。没有私聊A成功、真实CLI、模型或持续流覆盖结论。

## v9：实体显示反馈保留，第二次隐藏没有证据

在[此前v9观察方式对照](native-shortcut-v9-observation-control-20261016.md)之后，本轮使用同一已核v9包，配置`Command+Shift+Y`并取得程序“已注册”状态。管理后台id1、小窗id2先真实创建，再均隐藏；Agent把本轮自有空白Finder置前。之后不获取或激活NotAlone的CUA App，不用Computer Use代按该快捷键。

原人工阶段共用固定截止05:12:31.364Z。04:48:03.027Z的`focus-before-show-observed.json`是两窗hidden／unfocused。用户随后明确反馈“小窗出现了”；Root转达后才写匹配show nonce的人工收据，另存`human-show-feedback.json`，与程序观察分账。show的`expect.poll`确实曾满足同一小窗visible／focused、管理后台hidden，但随后的`focus-shown-observed.json`于04:57:38.475Z已经是两窗hidden／unfocused。它只支持瞬时断言通过，不能认证保持显示多久。

紧随其后的hide观察在04:57:59.487Z也已是两窗hidden／unfocused，发生在新的第二次实体隐藏操作得到反馈之前。本轮没有签hide成功收据，没有`focus-results.json`。本场运行时的旧[用例](../../desktop/tests/native-focus-acceptance.spec.ts)先观察、再等对应真人收据；隐藏断言只比较当前hidden，不要求由本次新按键造成的新转换，因此旧hidden快照不能代签第二次物理隐藏。若仅补一个人工收据，旧机器断言不会再次要求新的转换；本轮没有这样做。后继接续已另加发hide请求前的shown基线门，该防护未用于本场，也不补签旧结果。

只读检查本轮实际v9 ASAR及[窗口代码](../../desktop/src/main/windows.ts)确认：`blur`只通知生命周期，未在该回调调用hide；显式toggle在可见时hide，关闭和显式隐藏入口也可hide。没有找到“回Codex答题就自动隐藏”的产品契约。不能据此断言失焦、按键重复、OS或用户其他操作造成了本场状态变化，根因仍未知。

为避免逐步回Codex反馈打断焦点，在同一App和原截止内另装有限只读监听：只从该实例既有本机Node inspector读取窗口id、visible／focused，不执行窗口或快捷键动作。首次监听v1因全局`require`不可用报`inspector_read_rejected`，0次有效轮询，原失败保留；改用该实例已存在的`process.mainModule.require`后，v2在05:02:41.724Z取得3次连续hidden基线。05:03:16.575Z再实际确认自有空Finder前台及两窗hidden后通知Root就绪；Root协调“显示→停2秒→隐藏→最后回复”的实体序列，不由机器状态生成真人收据。

v2在原场结束前共5752次有效只读轮询，保存117条／29411字节，未达1024行／256KiB上限；状态变化会立即记录、相同状态仅每5秒心跳。未观察到新的shown或hidden-after-shown，没有完整序列收据，也没有收到本轮对应hide真人收据。轮询不能排除两个读数之间极短的未采样状态。监听于App收尾时以固定`inspector_read_rejected`结束，不能把其错误归因为产品快捷键故障。

最终用例在原截止附近等待human-hide超时：**1项失败、报告25.0分钟，runner code1／signal null，05:12:30.777Z完成**。用例末尾的公开菜单退出认证未执行；夹具收尾后App退场。没有延长截止、重启或将已有hidden改写为成功。Root随后明确通知用户该场已结束、不要继续按。首次实体显示可记录为部分正向体验反馈，完整“显示／第二次隐藏／正常退出”仍未通过。

## 实际命令与最小核验

已激活Conda NotAlone后，有限协调器先获取自有interactive租约并通过既有broker执行以下两个子命令（cwd为`desktop/`）。版本对应的绝对`NOTALONE_TEST_APP_EXECUTABLE`仅从已核包路径在端侧传入；未调用`npm run test:app`，未执行其build步骤：

```sh
NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE=1 NOTALONE_FINDER_NATIVE_SECONDS=45 \
  node node_modules/playwright/cli.js test tests/finder-native-permission-acceptance.spec.ts \
  --workers=1 --retries=0 --repeat-each=1 --max-failures=1 \
  --output artifacts/gui-permission-keyboard-20261016-6fc04721-d6db-4c77-b573-bd0c2a77e5cd/finder-v6/playwright

NOTALONE_NATIVE_DESKTOP_ACCEPTANCE=1 \
  node node_modules/playwright/cli.js test tests/native-focus-acceptance.spec.ts \
  --workers=1 --retries=0 --repeat-each=1 --max-failures=1 \
  --output artifacts/gui-permission-keyboard-20261016-6fc04721-d6db-4c77-b573-bd0c2a77e5cd/shortcut-v9/playwright
```

这些子命令还依赖协调器注入的有限租约白名单与broker授权，不是脱离门禁的直接重跑指令。v6 App本体仍由上述真实Finder动作启动，v9本体由隔离Electron夹具启动。源代码和冻结包未构建或修改；现有用例和初始dirty均未编辑。

实际包核验使用Node `createHash('sha256')`读取ASAR、核心库及两个可执行文件，并执行`codesign --verify --deep --strict`、各可执行文件的`codesign -d --verbose=4`；检查集合和结果保存`package-verification.json`。实际只读收尾使用以下同类精确命令，不列其他测试库、不读取连接凭据：

```sh
ps -p <仅从本场owned记录提取的18个PID> -o pid=,ppid=,pgid=
```

该精确`ps`退出1且stdout／stderr均空，表示没有匹配PID；第一次脚本把这一预期状态当作异常抛出，随后按status0／1与空结果重新核验，没有执行kill。Node `process.kill(pid, 0)`及两个已记进程组的`process.kill(-pgid, 0)`均为ESRCH。原目录只查`lstat/stat`存在性和dev／ino，不读取原配置。Conda NotAlone的psycopg沿夹具原有`host=/tmp dbname=postgres`连接，并设置`default_transaction_read_only=on`，只执行：

```sql
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_database WHERE datname = %s
);
```

参数仅为`finder-native-coordination.json`内已验证随机`notalone_binding_[0-9a-f]{32}_test`库名，结果false；没有列库、删除未知库或接触业务库。

## 独立清理与原AC结论

05:14:34.805Z独立核对本场18个已记录PID全部gone、2个owned runner进程组gone，v9临时userData与v6 owned目录／握手均absent，原默认userData的dev／ino恢复。精确随机PG不存在。协调器05:13:32.165Z正常exit0、activeLaunchCount0、两组gone后才正常release自有租约；共享interactive.lock absent。只读监听及两个runner会话均结束，自有空Finder窗口实际关闭。仅核这些已记录资源，不扩称所有未记录后代或全系统清理。

| 原票／AC | 本场严格结论 |
| --- | --- |
| 18 AC1：最小视觉采集边界 | 维持原已勾。本轮群聊暂停和小窗暂停是补充；不认证私聊A或全部采集性能。 |
| 18 AC2：歧义／失败不猜、不生成及草稿隔离 | 维持原已勾，本场没有新增该完整行为覆盖。 |
| 18 AC3：小窗暂停、已确认CLI独立及新宿主路径／签名／权限台账 | **本轮补齐v6 Finder新宿主与包内formal／aux的准确责任归属子项，并更新权限记录；不能仅凭本场把整条勾满。** CLI独立性仍是[此前v5组合](../foreground-contact-follow/real-cli-visual-20261015.md)的范围，本轮v6空CLI和v9空后端均未重验该项；本报告不宣称同一最终包的完整组合。 |
| 20 AC1：Finder实际启动 | 维持原已勾；新增v6实际独立Finder与后端连接正向证据。 |
| 20 AC2：探针／路径／签名／权限、真实快捷键、剪贴板和停读 | **保持未勾**。v6权限分项有实证，v9第二次实体隐藏及该场正常菜单退出未认证；本场未重验剪贴板或真实CLI退出停读。 |
| 20 AC3：完整相关检查／双轴与集成记录 | **本报告不能使该条整体验收通过**。需将本报告独立双轴审查与当前最终版本的各项适用范围另行核对，不能把两场加历史模型／CLI成绩合成同版全绿。 |
| 20 AC4：合成模型范围与隐私边界 | 维持原[非默认v6单次App模型结果](reply-model-smoke-result-20261016.md)的已勾及限制；本场模型请求0，不借用旧额度，不新增模型质量结论。 |

整票结论仍为部分验收；未增加双联系人、真实来信或新的私聊A成功标准。两场不证明完整当前包交付、默认模型配置、真实来信、关系上下文质量或任意新联系人权限。接续时已完成本文及权限文档追加的独立两轴审查；初审的历史用例时态与归属行计数措辞已纠正。未据两场修改原票AC或补签旧结果。
