# 图片与视频窄校验器

媒体获取、图文记忆与删除的现行合同见[数据契约](../../architecture/current/domain-data.md#消息去重与图文来源)和[隐私规格](../../architecture/current/privacy-deletion.md)。本页只描述原生格式／解码接口；图片取得与来源认证由正式媒体服务负责。

只读受信任媒体保存服务已登记的文件描述符3，不接受路径、URL、XML或密钥；标准输出只有固定格式与可用性字段或有限错误码。`native.ts` 从受管路径以 `O_NOFOLLOW` 打开、核验独立普通文件身份、传递FD，并在退出后复核；32MiB、10秒墙钟、有界4096字节输出，取消后等待子进程退出。缺制品返回 `media_validator_unavailable`，运行时不编译、不联网或安装。

显式开发构建：`bash native/media-validation/build.sh`。使用本机Swift SDK、arm64/macOS15部署目标，编译到随机临时文件再原子发布 `.build/media-validation`；不会原地重写正在使用的二进制。构建要求输出卷和临时卷至少15GiB。`.build`不提交；发布与离线制品接线仍由后续发布任务验证。

`validateVisual(localPath, kind, signal)` 与 `createVisualValidator(binaryPath)` 是受信任装配入口。返回形状复用 `backend-ts/src/media/visual/contracts.ts`，不含原图质量；图片质量及来源完整读取证明由媒体适配器独立核验。

## 当前支持与限制

- PNG：完整chunk边界、CRC、IEND及实际像素解码；APNG明确不支持。
- JPEG：SOI/EOI边界及ImageIO实际像素解码。平台解码器的宽松修复能力不代表原微信资源没有历史损坏；完整复制必须另有来源字节数与摘要证明。
- GIF：完整子块/trailer、声明帧数与ImageIO帧数一致，每帧实际解码；最多120帧。
- BMP：完整声明长度与像素区，仅24/32位未压缩或32位标准RGBA bitfields；DIB40/108/124。其他BMP分支拒绝。
- 全部图片：每帧最多40M像素，合计最多80M像素；每帧实际绘制以强制解码。TIFF、HEIC、WebP、SVG及其他格式明确不支持。
- `media-validation wxgf` 是独立的有界解码命令：fd3 接收已解密的 WXGF 文件，stdout 仅输出已实际解码并完成 PNG 结构与像素校验的单帧 PNG，stderr 仅输出错误码。输出是供显示的解码派生图，不证明源字节可逐字节复制或图片消息关联；调用方仍须验证受管文件及其消息关联，无需额外证明源字节符合“原图”资格。WXGF 内嵌 JPEG/PNG 与 HEVC Annex B 均受支持；遇到非法包头单元时，仅可在4KiB前缀内恢复到合法VPS，之后必须有序包含SPS/PPS和画面数据且所有HEVC单元头有效。HEVC最终解码恰有一个画面，尺寸不超40M像素，输出不超32MiB。
- 视频：仅完整MP4，1条H264视频轨及至多1条AAC音轨，所有轨解码到`AVAssetReader.completed`，检查非空样本和末尾时间覆盖。最多120秒、60fps、7200视频样本、每帧40M像素；音频最多双声道48kHz/6M采样。保守拒绝其他轨道、codec、fragmented MP4、外部引用及未知容器。
- MP4先检查所有顶层atom长度，限定自包含data-reference，禁止引用其他文件或URL。AVFoundation不能直接打开`/dev/fd/3`，因此窄`AVAssetResourceLoader`仅响应固定内部URL的精确有界Data范围；不读取其他路径，不生成第二份临时媒体。

来源完整复制、格式/解码及原图质量分别记账；这些合成格式验证不认证微信消息到资源的关联，也不证明所有同格式文件或真实微信媒体可用。Electron实际播放器兼容由正式页面测试另行验证；本模块不作视频转码；WXGF 的显示解码按上方独立命令处理。

## 合成验证

`node --test native/media-validation/test.mjs`：显式构建helper及合成夹具，PNG/JPEG/GIF/BMP实际解码、WXGF内嵌JPEG/PNG及VideoToolbox生成的HEVC Annex B实际单帧解码、WXGF多帧/截短/未知封装拒绝、四种图片多种尾部截短、PNG坏CRC、121帧GIF、MP4 H264与H264/AAC全轨解码、HEVC/MP4截短/外部引用、缺helper、超32MiB、符号链接、在途取消及实际10秒墙钟超时。夹具临时目录在测试结束删除。生成器只生成16×16纯色图片、2帧/2秒视频与静音，不含私人资料。

其他集成测试可使用 `bash native/media-validation/build-fixtures.sh <已创建的绝对目录>` 生成同组自包含夹具。脚本按源码mtime复用本机测试生成器，更新时原子发布；产品不会调用该脚本。

既有验证记录使用 Swift6.4、SDK27.0.1、macOS27.0.1、Node24.19.0、arm64；它只描述当时环境，macOS15 部署目标编译不等于 macOS15 实机验收。本轮入口整理未重跑原生或真实媒体验证。

## 一手接口依据

2026-10-29核对本机SDK头文件与Apple官方资料：[ImageIO source](https://developer.apple.com/documentation/imageio/cgimagesource)、[图像实际创建](https://developer.apple.com/documentation/imageio/cgimagesourcecreateimageatindex(_:_:_:))、[图像状态](https://developer.apple.com/documentation/imageio/cgimagesourcegetstatusatindex(_:_:))、[AVAssetReader](https://developer.apple.com/documentation/avfoundation/avassetreader)、[轨道解码设置](https://developer.apple.com/documentation/avfoundation/avassetreadertrackoutput)、[受限资源加载](https://developer.apple.com/documentation/avfoundation/avassetresourceloaderdelegate)、[精确字节响应](https://developer.apple.com/documentation/avfoundation/avassetresourceloadingdatarequest/respond(with:))。SDK明确`nil` outputSettings只读压缩样本；实现指定BGRA/PCM，逐轨读完，不能以只读头部/首帧替代实际解码。

Node依据：[v24 child_process](https://nodejs.org/docs/latest-v24.x/api/child_process.html)、[v24 fs](https://nodejs.org/docs/latest-v24.x/api/fs.html)。进程只继承受控FD、无shell、无私人环境；错误不带路径或输入字节。
