# Hasselblad 3FR 嵌入预览插件

`hasselblad-3fr` / `0.1.0`，Node 22 ESM，贡献 `image-preview@1` 的 `preview` 能力，`permissions: []`。
仅从经典 TIFF 包装的 `.3fr` 提取**已有的连续 JPEG 预览范围**，不做 RAW 显影、去马赛克、传感器解码、EXIF 编辑或文件写入。TIFF 本身不能识别相机品牌；宿主必须提供已判定为 `.3fr` 的输入（扩展名先转小写）。

## 开发、安装与发布

在 MO Gallery 多仓库布局下进入本目录：

```text
pnpm install
pnpm test
pnpm build
```

SDK 来自 `file:../../../emulsion-desktop-v3/packages/plugin-sdk`。构建将 SDK 的 JSON-RPC transport 一起打包到 `dist/main.mjs`，正式运行无需 TypeScript loader 或工作区依赖。测试直接使用 Node 内置 runner，无第三方测试依赖。

本插件需要宿主实现 `image-preview@1` 及输入 transfer 读服务。开发联调：先运行 `pnpm build`，再在 Desktop 插件管理的开发目录设置中选择本目录（仅开发模式），沿用现有开发目录加载流程，不修改用户配置文件或关闭校验。加载插件或正式安装后，在资源库执行“修复缩略图”，重新处理此前缺少预览的 3FR。

正式安装/发布必须按仓库 [CONTRIBUTING.md](../../CONTRIBUTING.md) 使用 `emulsion-desktop-v3/build/package-desktop-plugin.mjs` 生成包含 manifest、入口、checksums 和受信任 Ed25519 签名的 ZIP；开发目录流程不替代正式包签名、安装校验或权限检查。`permissions: []` 是能力声明，**不代表 OS 沙箱**。

## 协议对接

使用现有 SDK `JsonRpcStdioTransport`（换行 JSON-RPC 2.0，stdout 仅协议，512 KiB 行上限）。当前 SDK 的核心发现接口是 `plugin.getManifest`，本插件也接受 `initialize({coreApiVersion:'1'})` 并返回同一 manifest；不兼容 core 版本报错。没有在 SDK 中增加或修改 domain API。

- `image-preview.getFormats` → `{formats:[{extensions:['.3fr'],format:'3fr',mimeType:'image/x-hasselblad-3fr'}]}`。
- `image-preview.extract` 参数：`{input:{id,size,...},extension:'.3fr',maxPreviewBytes,maxPixels}`。
- 成功：`{mimeType:'image/jpeg',offset,length,width,height}`，所有范围都相对于**同一个输入 transfer**。
- 插件通过 SDK `transport.request('host.transfer.read',{transferId:input.id,offset,length})` 随机读取；响应字段依照 SDK `src/host.ts`：`{data:base64,offset,next,eof}`。要求返回请求的完整范围，校验 base64、offset、next；短读/错误会使提取失败。
- 不返回路径、URL、输出 transfer 或整个 JPEG 的 base64。宿主必须保留同一已打开的输入，重新校验范围、JPEG 解码及尺寸，不能因插件声明有效就跳过校验。
- 同一进程最多一个提取；并发请求报错。取消由宿主终止专用进程；单次 transfer 请求超时 30 秒。没有预览、格式不符或预算耗尽均返回 JSON-RPC 错误。

## 算法与兼容性边界

支持 `II`/`MM`、magic 42、主/next IFD、SubIFD/ExifIFD/GPS IFD 和偏移数组；从 JPEGInterchangeFormat、StripOffsets、TileOffsets 指定的位置检查 SOI。忽略不可靠的声明长度，通过 JPEG marker 链、segment 长度、SOF/SOS、熵数据 stuffing/restart、EOI 找到真实范围，避免把 APP/EXIF 内的假 EOI 当结尾。传感器 strip 不以 JPEG SOI 开始则跳过；连续分条无需拼接，非连续 JPEG 不支持。

在调用方 bytes/pixels 限制内选择像素面积最大的候选（同面积保留先找到的）。只做 JPEG 结构及尺寸验证，不做熵解码，故最终可解码性必须由宿主验证。支持 8-bit SOF0/1/2（baseline/extended sequential/progressive）；不支持 BigTIFF、无损/算术 RAW JPEG、缺少 SOF 尺寸、外置预览或完整 RAW 显影。

大文件只随机读取 TIFF 指针目标，包括 64 MiB 之后的尾部；仅当整个输入 ≤64 MiB 时分块全扫描兜底，保持小文件中未登记/更大预览的发现行为，不把大文件整读入内存。所有阶段共用预算：

| 资源 | 上限 |
| --- | --- |
| 单次 host read | 256 KiB（JPEG 窗口 64 KiB） |
| 单个预览 / 调用方 maxPreviewBytes | 32 MiB |
| 总读取量 / 读调用次数 | 128 MiB / 4096 |
| 调用方 maxPixels | 80,000,000 |
| IFD 数 / 深度 / 每目录 entries | 128 / 16 / 1024 |
| JPEG 候选 / 每 JPEG 结构 marker 数 | 512 / 65536 |
| 每 offset 字段检查数量（预览 / 目录指针） | 512 / 128 |
| pending IFD 队列 | 256 |

预算与宿主一致。范围和请求数值必须是安全整数且不越界；`maxPixels` 为 1..80,000,000，`maxPreviewBytes` 为 4 字节..32 MiB。熵数据中的 FF00 stuffing 和 RST 不消耗结构 marker 额度，仍受字节、读取量和调用次数限制。非 JPEG sensor strip 只消耗三字节探测及读调用预算，不占 JPEG 候选额度；探测位置去重集合最多 4096 个。

32 MiB 连续 JPEG 约需 512 次 64 KiB 窗口读取，另有 TIFF 和探测开销。多个候选共享总预算，可能正当耗尽；读取/候选预算耗尽报错而不是返回未充分检查的结果。目录和 offset 数组遍历有上限，因此异常或极复杂容器不保证发现所有预览。文件过大且没有可用 TIFF 指针时不会盲扫。

## 测试

`node --test tests/*.test.mjs` 使用内存合成 TIFF/JPEG marker fixtures：双端序、三类偏移 tag、子目录与循环、150 MiB 稀疏尾部、thumbnail 与较大 preview、错误长度、无预览/传感器数据、截断、字节/像素/读取预算、跨 chunk SOI、next IFD、坏 offset、格式和 transfer 协议。fixtures 验证 marker/range 行为，不是相机实拍或 JPEG 解码测试。真实 3FR 与宿主完整集成需要另行联调；Desktop 原有 `MO_TEST_RAW_FILE` live test 可用于宿主回归。
