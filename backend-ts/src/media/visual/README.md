# 图片与视频类型合同（17）

`contracts.ts` 的 `VisualResourcePort.open(request)` 是19的认证资源接点。request只包含当前固定消息、实际来源、完整读取资格、目标、取消信号和checkpoint；没有任意SQL、文件路径、save或批量范围。端口必须先证明当前账号/绑定/来源代次和唯一消息到资源映射，再打开精确资源；无法证明时不读字节，返回 `media_association_unverified`。字节流及打开须响应取消，close等待全部在途读取结算且不留下XML、路径、密钥或字节缓存。

资源返回固定快照的预期长度、SHA-256、完整读取声明、与request逐字段相同的读取资格和16的窄关联证明；预期长度/摘要不得由本次收到的片段补造。图片质量与可解码性分开，original/thumbnail必须有同资源可靠质量证明；否则unknown。只允许内部受信任装配注入，HTTP/renderer/Tool不能构造端口或资源。合成资源登记仅证明类型与生命周期，不能认证真实微信归属。

适配器在调用端口前独立复制并冻结预期source/token，再向端口传另一份冻结副本；端口不能联合改写输入和后验比较的预期。返回资格、关联、质量、预期长度和摘要固定为打开回执快照，字节流不能中途变更这些证明。任意端口代码的实际来源读取仍需19认证；此防护不把受信任端口变成任意代码沙箱。

`VisualMediaAdapter`（`adapter.ts`）消费此端口，按32MiB上限复核源流完整性，必要时纯字节解密，通过16的save写入独立受管副本并调用窄原生探针实际解码，最后才返回窄关联证明。原图补提未取得原图明确失败。文件发布、降级拒绝、来源/联系人删除、暂存与预览ACK全部复用16同一服务/删除注册/holders，不新增迁移或删除平台。未认证真实资源时正式宿主继续 `adapters:[]`；19认证后仅需把实际端口装入 `new VisualMediaAdapter(port)`，保持其他类型适配器。

`dat.ts` 只消费已有字节，不读配置或文件。算法依据固定wechat-cli 2.0.1-rc.5，commit `795071fa0591da5fc2c6ab94a70f22ccd93ef06c` 的 [main.go](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/main.go) 3963–3971、4136–4212、4305–4340；V1公开格式常量与V2受控内存密钥分开。V4只接受两个完整6字节头、15字节头及已验证保留位0，长度在安全整数内先核验AES对齐和XOR尾边界；Node内建AES-128-ECB默认验证PKCS7，再核解密长度等于声明。未知封装/WXGF返回unsupported，缺失或不匹配V2密钥返回needs_image_key，不执行wxkey、进程扫描、刷新或兄弟文件搜索。版本头/XOR匹配只是转换候选，仍必须通过格式与实际解码。

第三方API依据：本机Node v24.19.0及锁定 `@types/node 26.6.4`，已核对 [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) 的createDecipheriv/update/final及默认padding合同。未新增npm依赖；上游MIT完整告知见 `WX-CLI-LICENSE.txt`。原生helper的编译、限额和支持矩阵见仓库 `native/media-validation/README.md`。
