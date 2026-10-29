# 17：图片与视频提取

Triage: ready-for-agent
State: resolved
Type: task
Parent: [微信媒体资源提取与语音文件转换](../../wechat-media-extraction/spec.md)
Blocked by: [16 单条媒体保存与清除](16-single-message-media-lifecycle.md)

> 2026-10-29实现与本票验收完成；真实微信资源归属由19继续认证。[任务索引与共同约定](../planning.md)。

## 交付行为

用户明确选择已确认且勾选联系人下的一条图片或视频消息，得到应用保存并核验的可查看／可播放副本，以及原图、缩略图、质量未知或失败的准确状态；需要原图时由用户明确补提。图片和视频各有可操作页面、正常接口与删除接入，不把可用入口推迟到19。

本票在16的独立副本、尝试身份、受控发布和统一清理上接入类型适配器，保持[媒体规格](../../wechat-media-extraction/spec.md)Q1–Q11及[统一数据库设计](../../sqlite-database-rebuild/greenfield-design.md)的角色、质量和文件关系。当前真实资源未认证时先用明确合成资源贯通，19按类型核验真实归属。

## 验收条件

- [x] 正常接口和页面支持单条图片、单条视频及图片原图补提，展示提取、质量、可用性和错误状态；不按选择联系人、页面打开或同步占位自动下载，不支持多选或整联系人批量。
- [x] 每次新读取复验App运行、已核验账号／绑定／来源、当前联系人勾选和读取总开关，持续遵守16的资料／选择／媒体代次与租约；未认证的消息到资源映射不能执行真实读取，不根据文件名、时间邻近或含糊回退取首条。
- [x] 图片和视频成功结果是应用保存的独立受管副本；原微信路径仅作必要来源定位，不直接作为保存成功证明，不跨消息共享文件，不修改微信或用户已有文件。
- [x] `.dat`只按已核验的V3 XOR、V4 V1／V2纯字节合同处理；严格核验版本头、长度和整数边界、AES分段及padding，再将输出交给内容识别和实际图片解码，不能凭猜出的文件头宣布成功。
- [x] V2只使用当前已授权账号范围内既有且经核验的受控密钥，密钥仅在受控内存中使用、不入库／日志／命令参数；缺失或不匹配明确返回 `needs_image_key`，不自动运行wxkey、扫描进程、刷新密钥或搜索无归属兄弟文件。
- [x] WXGF及未核验封装明确返回 `unsupported`；不改扩展名、不把未知容器交给下游冒充支持，也不因明确失败擅自取消已确认的图片功能目标。
- [x] 图片按内容核验格式、尺寸、总像素和实际解码；动画还核验支持的帧范围及资源上限。可打开、尺寸大或扩展名正确都不能证明原图或资源复制完整。
- [x] 原图质量只接受可靠资源质量证据；明确缩略图可作为有限结果并标“原图未取得”，无证据标未知；质量证据与可查看性分别记录，后续原图需新明确请求，失败不降低已有合法原图。
- [x] 视频副本分别核验完整资源读取／复制证明、实际容器和受支持媒体轨道／播放能力；仅文件存在、路径可访问或扩展名正确不算可播放，未知codec或截断明确失败或标明受限结果，不假报完整成功。
- [x] 类型处理遵循先登记、写入校验、短事务发布当前组合和旧清理意图；只留当前所需文件及尝试记录，新结果失败保留仍合法旧成果，有限／未知新结果不得降级旧完整结果。
- [x] 清单条媒体保留消息占位；来源／联系人失效经统一删除闭包清除自有副本、派生图片、定位／XML证明、暂存和活动引用，晚到处理不能复活旧结果，微信及用户外部原件保持不动。
- [x] 空间不足不驱逐已有媒体；取消、关闭读取、清除、退出和崩溃按16停止或中断，新明确操作才新执行，同请求键重送不重执行、不自动重新读微信。
- [x] 同票通过正式接口、页面和真实受管文件验证图片解密成功／失败、缺密钥、坏padding、超长声明、未知格式、缩略图／未知质量、视频截断／不支持codec、原图补提失败及删除晚到场景；图像和视频真实支持矩阵分别记账。

## 验证与证据

依据[媒体运行时研究](../../../research/sqlite-ready-media-runtime.md)复用固定源码和7项`.dat`合成字节合同，不把该结果写成真实`.dat`或所有格式已经可用。以隔离SQLite、独立目录、已登记的合成图片／视频和正常类型适配器执行最小相关检查；复制、容器、可查看／播放和质量证据分别报告。

真实验证按19限定到用户明确指定、授权仍有效的一条消息，当前范围或唯一关联无法核验则不读。提供实际命令、页面反馈、类型矩阵、明示替身、未验范围及自有资源清理记录；既有12／14组合成机制不能代替图片或视频的真实资源归属认证。

## 范围与执行门禁

- 本轮只发布任务，不启动实现、产品、微信或模型；后续用户明确要求实现后才执行。
- 后续桌面只用 `pnpm run dev`，先 `pnpm run dev:status` 核验并复用实例，常驻进程放后台；禁止自行打包、运行安装包、绕过发布门禁或执行push／PR等远端操作。
- App首次使用整条线继续搁置，不做首用向导、组件准备、新模型设置、干净机器／发布或迁移／恢复实验。
- 未核验真实账号、联系人、读取范围及类型资源归属时不读取微信；不自动启用同步或扩大权限。
- 不做OCR、ASR、媒体模型理解、云上传、批量提取、自动重提或跨消息共享；最终外部消息仍由用户亲自发送。

## Answer

2026-10-29完成。本票图片/视频类型、正式接口/桥/页面、独立受管文件及删除验收已通过；真实微信资源映射未认证，正式宿主对应读取仍不可用，不能把合成机制验收写成真实微信媒体已支持。首用、发布、干净机器和迁移/恢复保持既定排除范围。

### 实现与接线

- `backend-ts/src/media/visual/contracts.ts` 提供单消息VisualResourcePort；`adapter.ts` 导出 `new VisualMediaAdapter(port, validator?)`，默认开发校验器为native.ts的validateVisual，正式装配可用createVisualValidator指定已核验helper。端口先认证实际账号/绑定/来源代次及唯一映射，再提供固定完整资源。没有认证端口时不安装，不接受HTTP/renderer的路径、字节、SQL、密钥或关联证明。
- 独立复制并冻结预期source/token，再给端口另一份冻结副本；返回资格、关联、质量、长度和摘要固定于打开回执。已通过真实SQLite反例证明原来的source/token联合改写及流中途改长度/摘要都可被接受；修复后不能消费越界流或发布。受信任端口的实际读取仍须19认证，本票不宣称任意代码沙箱。
- DAT按锁定wechat-cli 2.0.1-rc.5 / 795071fa0591da5fc2c6ab94a70f22ccd93ef06c的纯字节V3 XOR和V4 V1/V2合同处理；先核版本、保留位、整数长度、AES分段及PKCS7，再核实际图片解码。V2缺/错受控密钥为needs_image_key，未知封装/WXGF为unsupported；不扫描/刷新密钥或搜索兄弟文件。密钥仅本次内存使用，MIT完整告知随模块保存。
- 原生helper只读继承FD3；ImageIO按内容核PNG/JPEG/GIF/BMP容器边界、尺寸和全帧实际绘制，AVFoundation核MP4自包含引用、H264及AAC全轨解码到completed。先做容器完整边界，避免系统宽松解码容忍截断而假报成功。32MiB/10秒及像素、帧数、时长等上限明确拒绝，取消/超时等待进程退出；运行时不编译、下载或安装。
- 质量和可查看性分开。original/thumbnail必须有可靠同资源证明，否则unknown；原图补提无original证明明确失败，失败不替换合法旧件。实际App发现16×16合法视频控件被原尺寸挤压，已最小修正预览最小尺寸并以原生播放控件/键盘验证可操作。
- 完全复用16同一MediaAdapter/save、Holders、DeletionService及删除域。外部读者以新增最小内部 `context.retainReader(close)` 登记到同一attempt holder，close失败保持未释放，原删除重试实际关闭成功后才释放。未新增迁移/删除域，不改已发布media v6。原始DAT只在本次内存处理，不新增持久暂存或全局缓存；微信及用户原件不修改。
- 公共文件只有16的contracts.ts/service.ts/README.md最小读者钩子、MessageMediaPanel.tsx的具体错误/可操作尺寸和inventory本票一行；未改host/main/preload/registry/历史原生协议/依赖。ADR-125与模块README记录合同和支持限制，架构索引由总集成归口。

### 实际验证账

Node24.19.0，锁定TypeScript7.0.2/Electron44.7.0，离线frozen安装无package/lock变更。Swift6.4、SDK/macOS27.0.1、arm64；macOS15只验证部署目标编译。官方源、Node/Apple接口及具体限额见两个模块README。

```bash
# 初始相关业务、DAT及原生：17/17；后续新增实际10秒超时单例1/1
node --test backend-ts/test/visual-dat.test.mjs backend-ts/test/sqlite-visual-media.test.mjs native/media-validation/test.mjs
cd backend-ts && node --test --test-name-pattern='真实10秒墙钟' ../native/media-validation/test.mjs
# 释放失败与错误分类修复后的媒体/DAT相关回归：34/34
node --test backend-ts/test/sqlite-visual-media.test.mjs backend-ts/test/sqlite-media.test.mjs backend-ts/test/visual-dat.test.mjs
# 最终别名修复后类型模块：12/12（包括两个新反例）；不重跑未变化的基础/原生模块
node --test backend-ts/test/sqlite-visual-media.test.mjs
# 两端类型检查通过，最终相关变更后各补一次
pnpm --dir backend-ts run typecheck
pnpm --dir desktop run typecheck
# desktop/：正式桥页面及原页面回归3/3；最终小尺寸/错误矩阵分别定向补验各1/1
node --test tests/visual-media-integration.test.mjs tests/message-media-view.test.mjs
node --test --test-name-pattern='真实视频类型' tests/visual-media-integration.test.mjs
node --test --test-name-pattern='真实图片类型' tests/visual-media-integration.test.mjs
```

服务覆盖：错误账号/联系人/代次、完整资源长度/摘要不符、V3/V4成功、缺密钥/坏padding/超长声明/未知封装、V2实际解码不匹配、正确密钥解出不支持APNG、可靠缩略图/未知质量、原图补提失败、停读及同键不重读、来源删除等待读者及晚到不能复活、close失败阻止删除completed并沿原操作重试。空间不足/崩溃/并发/跨消息独立文件等16有效证据复用，未把模拟ENOSPC写成真实磁盘耗尽。

正式页面使用生产认证HTTP、BackendHost/RuntimeClient、具名桥和CSP、实际类型适配器及受管文件；只有账号/渠道资源端口为合成。DAT成功/失败、V2缺密钥、坏padding、超长声明、WXGF/未知格式均经过正常页面；失败保留旧原图。视频H264/AAC以浏览器原生Space键播放并观察时间推进，HEVC/截断明确失败；图片/视频清除均先撤DOM/src/blob再ACK，ACK前文件仍在、删除未完成，ACK后文件消失，外部合成原件保留。

Standards初审释放失败P1、Spec初审V2不支持格式误报密钥P2均修复；两轴最终各0项残留。最后别名和尺寸改动又各自独立复核，均0项；两个新反例各2/2通过。基线12项既有测试缺inventory登记仍存在，本票仅登记新用例，未宣称默认全量通过。

### Computer Use实际App

使用本票明确工作树、`pnpm run dev`及独立合成userData，全程读取总开关关闭，无真实微信/模型。正式宿主无认证类型端口，因此App验证已由真实类型适配器生成的副本；明确提取/补提完整链由上述正常接口/页面覆盖。未注入假的业务快照或绕过认证。

- 管理页核到SQLite v6和读取关闭；合成甲无消息，按实际contactId归属选择合成乙后显示4条消息。图片显示“缩略图，原图未取得”和PNG预览；单独清除后实际图片节点/文件行撤下，占位保留。
- 实际16×16 MP4原控件过小的缺陷先补定向失败回归再修正；热更新后重新打开正常媒体面板，原生play按钮可操作，实际进度从0:00推进到0:02。
- 对同视频来源执行正常认证DELETE，播放器、播放文件行和旧结果快照实际撤下；后台completed，受管文件0。随后删除该合成联系人并正常刷新，目录、选中联系人、旧聊天正文及媒体快照全部撤下，不是仅禁用按钮。
- 最终正常Cmd+Q退出，定向dev:status为stopped/pids[]；重开正式存储检查integrity/FK均ok，三次删除均completed，媒体文件0。确认无进程引用和Git跟踪后，自有userData16048KiB与开发缓存3792KiB合计约19.4MiB清理至0；保留当前原生helper/生成器268KiB。
- 启动准备曾因通用nohup监督器随工具进程组退出留下未就绪宿主；核实自有合成归属、无后台连接后先请求app.quit，无响应才清理该自有宿主。最终以独立进程组后台运行同一pnpm开发入口成功，正常退出完整。使用同锁44.7.0既有官方Electron分发，不是NotAlone打包版；未改启动/发布门禁或私人配置。

### 支持矩阵、数据影响与集成

| 类型 | 纯字节/原生 | 正常服务/桥页面 | 实际App | 真实微信归属 |
| --- | --- | --- | --- | --- |
| PNG及DAT派生PNG | V3/V4 V1/V2合成+ImageIO通过 | 成功、反例、质量、预览/清除通过 | PNG预览/清除通过 | 未认证，保持不可读 |
| JPEG/GIF/BMP | 容器/全帧/截断/上限通过 | 不作全部变体页面认证 | 本票未逐格式实机 | 未认证 |
| MP4 H264（可有AAC） | 全轨解码通过 | 实际播放、截断/codec错误及清除通过 | 原生控件播放0:02/来源删除通过 | 未认证，保持不可读 |
| WXGF/APNG/TIFF/HEIC/WebP/其他codec | 当前明确unsupported或不在支持矩阵 | 明确失败，不伪报成功 | 不承诺支持 | 不放行 |

未读取真实ran媒体；现存CLI普通制品仅做必要路径投影和SHA256核验，未执行/读取密钥或私聊，其摘要不认证源码等价和媒体能力。不上传媒体、不入文字/记忆、不调用OCR/ASR/模型，无外部发送或撤回。本票无push/PR/打包。

源栈保留610e2648a8e4cd0b7f56592bc932b665d5195b5f、9e21fb989cb5a8eae80d85c29d81060118fed4cb、ae284457d0ab3f1118543d1769ec04fae24394d0、ef016bf83463a65b5e65fe036490250771b2be96；通过cc8c0a374d4194df1ac59d280a2909016504f9bc纳入根317b6820f3fcb3131004f7dc200e0132d043370e。16源221e7cc9c93653f1cf9e24a25417d2901db20427与集成2d82a52a4c3dd43b7712706a82c6e8cd6699e015均实际为祖先。最新提交及公开历史结论随最终回报；后续19只接认证资源端口，复用同holders/删除服务，不新增任意路径/SQL或改media SQL。
