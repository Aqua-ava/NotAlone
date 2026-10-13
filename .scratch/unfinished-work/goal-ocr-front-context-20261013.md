# OCR前台、最小采集与低置信实测（2026-10-13）

本记录补原18／20的实际证据，不替代绑定、完整App或模型验收。主Agent串行执行四个新有限场，全部经`npm run test:app -- --interactive --coordinator main-agent`与共享租约，均预登记12分钟／最多1次且实际1次，唯一测试为`tests/native-foreground-layout.spec.ts`。用户明确授权的单联系人仅在私有范围记录；没有切换其他会话、发送消息、真实CLI正文读取、模型调用或业务库操作。

## 场次与结果

| 场 | 台北预约窗口 | 实际时间／退出 | 结果 |
| --- | --- | --- | --- |
| C | 09:29:40.604192–09:41:40.604192 | 测试报告44.9秒／exit2；未独立测入口单调时间 | 坐标选择报`calibration_window_not_visible`，未保存有效选择，capture0 |
| D | 09:36:38.922968–09:48:38.922968 | 入口单调138.708860125秒／exit1 | 选择成功；末次正式微信前台、选择／front／sole PID一致，但`identity_changed`；capture0 |
| E | 10:01:33.971252–10:13:33.971252 | 入口单调131.543844875秒／exit1 | 新D包；选择成功，截止末次`calibration_context_unavailable`／front_other，四项差异未取得；capture0 |
| F | 10:06:18.155237–10:18:18.155237 | 入口单调96.388301375秒／exit1 | 用户另明确同意按提示保持微信前台60秒；实际经过context、capture-setup和sentinels-before进入names，`session_name_confidence_low`停止，无profile |

D／E／F三个完整入口单调时间合计366.641006375秒；C报告时间另列，不混称同一计时口径。D的旧七字段不能区分当时窗口编号、原点或尺寸差异，E末次非前台不能证明整段60秒均非前台；F通过精确context门也不能追认D原因。失败及未执行阶段全部保留。

## F的实际最小采集

F保存的九项白名单质量数值为：顶部名字180×50像素、置信0.5；选中行名字160×40像素、置信0.30000001192092896；顶部复读置信0.5；pixel_scale=2，names采集／识别634毫秒。名称字符串和图帧不写结果或本记录。

冻结的`MinimalSessionCapture`先通过实际微信前台／PID／windowId／CGRect精确门，静默`CGPreflightScreenCaptureAccess`成功，ScreenCaptureKit的display filter仅包含所选微信窗口，每次sourceRect只覆盖一个已选区域。三个细条依次为2×80、140×2、4×24像素；随后顶部、行名和顶部复读均返回。依据这条实际到达names质量输出的固定路径，可推断成功完成6次最小采集调用（3细条＋3名字），没有独立帧计数器，不推断框架内部次数。`Names.validate()`先验证三个名字非空且一致，再因最低置信不足0.90拒绝；这证明低置信安全停止，不能认证联系人绑定或可信定位。

帧沿CGImage／Vision端侧内存处理，源码没有保存或上传图像，结果只保存安全数值。主Agent用于确认测试会话／几何的Computer Use窗口截图同样仅在内存，不当作产品最小采集。没有全窗后裁剪回退、联系人词典猜测、降低门槛或扩大CLI授权。原18第1条获得实际正向采集及E非前台停采证据；第2／3条的重名、改名、绑定失效、生成保护、焦点／CLI独立和系统权限归属仍待完整组合，不因F低置信分项代签。

## 源码、签名与证据索引

必要身份诊断提交`d166a0f3`：已有末次resolve成功时只附PID／窗口编号／原点／尺寸四布尔，无新OS查询，旧七字段兼容；两轴剩余0，Swift13／Host6／安全50及类型通过，见[诊断片](goal-ocr-identity-checks-20261013.md)。原前台、CGRect、最小区域和0.90门字节保持。

新D通过公开`npm run package`构建，入口31.963362084秒／exit0，期间全部选定桌面及原生输入无漂移；280普通文件＋14链接。ASAR为`376c9a53920c4b7e5c927383e1b170ec755033ca5a96aa6573707204c48449ab`，六份dist逐字匹配；11份native输入摘要为`32315b3e11aaa18567d2392334d4e8112ec8a12c8aee9fb120ef907bcc946277`，四helper和九许可材料逐项哈希／严格签名匹配，App deep strict成功。仍为ad-hoc，无Developer ID／Team认证；静态签名和实际父子链不等于TCC责任进程已核实，WCDB精确源码／补丁／构建输入和完整二进制许可仍未取得。

| 私有证据目录／文件 | 内容与SHA-256 |
| --- | --- |
| `desktop/artifacts/goal-ocr-manual-front-20261013-c/` | 计划／失败／Root收尾，`root-owned-terminal.json`：4ca335c29713b661e263745c7e3067b6863ac3598c00442eab85d5901b53439c |
| `desktop/artifacts/goal-ocr-manual-front-20261013-d/` | 计划、选区、末次上下文、入口时间／自有进程，Root终态：c89a4308fd9f1d419be7d30e0d2c7be39249de20bcd7a95d8edbbc79ecab56e7 |
| `desktop/artifacts/goal-ocr-identity-20261013-e/` | 新D首场、末次非前台、14自有进程退场，Root终态：a37cda09364edd88a79cc86763b89bc8039ecb0c436e48a8c71609bdf1295aff |
| `desktop/artifacts/goal-ocr-identity-20261013-f/` | 实际names低置信／九数值／14自有进程，Root终态：8e1a5e8c36f3cbf14135b3a5022109bb40a904332ba98b7e55fb7d6eae7d9f70 |
| `desktop/artifacts/goal-final-package-20261013-d-build/` | build-plan／package.log／build-terminal、root-static-baseline-v1及ASAR-dist-verification-v1；不含图帧或私人资料 |

目录0700、验收计划和Root证据0600；打包App为交付文件权限，不宣称所有产物皆0600。E／F进程采样已排除ps自身，各14个已记录PID退场；D旧采样将ps子进程也计入462条，不能称462次App启动。F两个实际probe分别沿坐标选择与校验启动，父App和自身Resources路径认证，不混同测试App次数。当前目标App累计288次、发送仍8／12、对方来信0。

## 收尾与下一步

C测试曾保留cleanup_unconfirmed租约；Root核对自有租约dev／ino／owner／记录ID及已知PID后，仅清理该自有锁。D／E／F各已记录自有PID和userData消失，共享租约absent，对应包294项原字节／权限／链接及deep strict保持；无未知进程终止、未知库或业务删除。个体历史后端／数据库收据和全机进程覆盖不足仍明列，不补造。

F实际权限预检和捕获成功，但TCC责任归属未独立认证；只读`launchctl procinfo`预检明确需要root权限，没有提权。下一步先基于安全数值和官方识别接口提出有限端侧对照，原始帧不落盘／上传，0.90不变；有新假设和预注册后再安排现场。可信名称／profile、真实绑定及重名／失效／焦点组合、最后候选完整App验收分别补齐，不反复重演相同条件。
