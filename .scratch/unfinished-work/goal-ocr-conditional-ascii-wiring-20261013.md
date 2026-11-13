# 原18有界ASCII同字复核生产接线（2026-10-13）

Root在[H3独立实际证据](goal-ocr-ascii-recheck-plan-20261013.md)两轴收口并本地提交`b29f914e`后，明确批准将已实现候选接入原18会话名字采集。H3实际79／108、两项Latin症状改善、四负控拒绝和29永闭保持；M01／M02最低0.5且M02全文错误、F根因未知继续保留。该固定合成对照支持窄候选，不证明实际产品接线、微信绑定、TCC／签名或全部OCR质量。

## 本片准确范围

仅修改[MinimalSessionCapture.swift](../../native/macos/Sources/NotAloneSyncCore/MinimalSessionCapture.swift)的`Capture.names()`三次名字调用：顶部、选中行与顶部复读都显式使用`recognizeName(..., policy: .conditionalASCIIRecheck)`；另更新两个对应过时中文注释。内部wrapper默认仍`.baseline`，原`recognize`本体、`Names`及0.90、顶部复读一致保护、前台／可见／唯一窗口／精确几何、`image()`／sourceRect、sentinels及原始帧内存策略逐字不改，不新增CLI／环境开关、词典或采集。

每一名字小帧仍只采集一次。策略先原baseline识别，只有低分完整ASCII才在同一CGImage最多一次auto；候选全文UTF-8字节相同、实际confidence≥0.90且完整性仍有效才采用，否则原样保留基线。高分、非ASCII和无完整Name不追加请求；生产名字阶段因此是3次baseline、最多3次复核，而非H3为对照使用的另3次独立baseline。实际新包的调用数及成功率尚未观察，不把理论上限当本片实跑计数。

本片不修改权限／签名配置、backend、desktop、存储、放行表或原18AC；Root拥有另行权限台账／票据更新、打包签名和真实场次。本片与H3实验分别记录和提交，当前尚未启动任何App或读取真实帧。

## 最小验证与可证明边界

按Root批准仅执行一组：原布局9＋session安全4＋既有行为协议6＋旧H1／H3 closed入口2。实际21方法、19pass、2skip、0fail，测试0.009秒（suite外层0.018秒），编译2.50秒。六协议复用真实wrapper与可控识别回调，检验默认不追加、低分同字高分唯一复核、异字／不完整／低分回退、UTF-8规范等价拒绝、非法confidence／变尺寸和错误不重试；不是提示文字或源码字符串断言。两个旧入口都在合法closed分支跳过，没有运行Vision，旧32／79计数、40／29余额和全部封存不变。本次不新增镜像测试，也不伪造新的产品行为红。

实际命令：`swift test --package-path native/macos --filter 'MinimalRegionLayoutTests|SessionCaptureSafetyTests|VisionLanguageControlTests.testConditionalASCIIRecheck|VisionLanguageControlTests.testFixedPublicSynthetic(Language|ASCIIRecheck)Control$'`。限定入口未执行其他测试模块；本次Vision perform、App、微信、真实capture、PG、模型HTTP、发送和Git写入均0。

源码保持证明`source-preservation-proof-v1.json` SHA `8789fd703b50430d7f0feaa33541b3db3dd81ed1fd8aa9f4b792fa59e41f9565`：精确撤销三处调用及两个注释后逐字恢复`b29f914e`源SHA `e548868a7a7474208b1c5495c61c01d681ec49d4b07637ef80d3156fa1a0ae25`。当前源SHA `9bfd83b1bcf325e12c303d8f51076024ef665d01b829e1696a334a42042c0e94`，原测试仍SHA `4f33530f23058324e5b7cd383a89885800f8df52d9270bcee40355107e361699`；其它捕获／识别／门保护均随完整逆变更证明保持，没有按变更后的字符串写假测试。

现有`Capture`为private且初始化与`image()`必须经过实际微信前台、TCC和ScreenCaptureKit；没有不捕帧的生产image注入接缝。上述协议能验证内部策略，但不能在本片范围观察实际`Capture.names()`三调用选择。因此**生产接线集成验证仍为false**，不以编译、代码位置或协议绿签成功，也不扩大生产接缝来假证。Root将通过新签名候选包与独立有限真实微信校准场补证，若失败保留具体码，不能重开H3或降低0.90。

## 本片证据与后续

私有目录`/private/tmp/notalone-ocr-conditional-wiring-20261013-b29f914e/`为0700，原源快照、最小日志、固定补丁和证明为0600；原H1／H3全部实际收据只读取摘要核不变，不编辑或清理。没有App／userData／业务库资源新建，不启动CLI或探针；本片不声称完整进程覆盖。最终两路径SHA及实际日志由该目录`review-metadata-v1.json`绑定，两轴仍待独立源码审。验证后由Root独立本地提交、构建并执行新有限场；不会自动开启新模型实验、OCR对照或产品自动发送。
