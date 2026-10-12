# Semantic embedding — `embedding@1`（EmbeddingGemma 2）

> **状态：分词器已接线，能真的产出向量。** 宿主侧的契约改动（设计文档 §4.3，四处同改）已落地：
> `addons:onnx` 的域白名单现在是显式的 `{faces, embedding}`（`storage_plugins/capabilities.go:45`
> 与 `scripts/validate-index.mjs` 的 `ONNX_ADDON_DOMAINS`），`embedding@1` 有 `validateEmbeddingContribution`
> 做域校验，也有启动路径（`storage_plugins/embedding.go`）。索引条目已填五个平台的
> `url`/`sha256`/`size`，并声明 `minDesktopVersion: "0.8.6"`（**运行**本插件所需的最低 Desktop 版本）。
>
> 已完成：`manifest.json`、RPC 面（JSON-RPC over stdio + 二进制分帧）、规格常量、原生运行时加载、
> 两段式引擎、图像 patch 化预处理、模型 staging 脚本、Step 0 探针、**分词器接线**（`src/tokenizer.mjs`：
> 解析库由宿主随包 staging、`tokenizer.json` 走模型通道，见 §4.4 与下方「不可协商」第 4 条）、
> 39 条单测（含子进程 E2E）。真机实测（Windows / 50×50 网格）：单图 273 个 soft token、`input_ids`
> 长度 277、向量 ‖v‖² = 1.0000；真实照片 × 三条文本 query 的余弦 0.68 / 0.50 / 0.61（模型卡参考
> 0.74 / 0.46 / 0.51，**排序一致**）。
> **未完成**：宿主侧的向量库与全库批处理已经落地，但**查询路径与界面**还没接通——资源库的搜索框
> 目前仍只走 FTS5 关键词，所以本插件能产出向量，只是还没有地方去查它。

多模态文本 / 图像 embedding，给 MO Gallery 本地资源库做语义检索与语义聚类。
模型选型、许可、体积与验收标准见
[`embeddinggemma-2-design.md`](../../../.trellis/spec/emulsion-desktop/local-ai/embeddinggemma-2-design.md)。

## 与 `faces` 插件的两处结构差异

1. **两段式，不是单次前向。** 人脸是「一个模型一张脸」；这里是模态编码器先产出 512 维中间特征，
   文本塔再把它们当软 token 与文本一起编码，最终输出 768 维句向量：

   | 阶段 | 图 | 输入 | 输出 |
   |---|---|---|---|
   | 文本 | `model_q4.onnx` | `input_ids` + `attention_mask` + 三个模态特征（`[N, 512]`） | `sentence_embedding` `[1, 768]` |
   | 视觉 | `vision_encoder_q4.onnx` | `pixel_values` `[N, 768]` + `pixel_position_ids` `[N, 2]` | `image_features` `[tokens, 512]` |

   所以**引擎不替调用方决定多模态怎么拼**（占位符 token 插在哪属于分词/处理器那一层），
   只提供 `encodeImageFeatures` / `embedTokenIds` / `embedWithModalities` 三个不重叠的入口——
   任何需要猜占位符位置的地方都不会藏在引擎里静默出错。

2. **预处理是这一侧的职责。** 视觉编码器不吃 NCHW 图像，吃的是**切好的 patch 列表**（每个 patch
   16×16×3 = 768 维展开）加每块的行列位置。缩放、切块、拼张量都由 `src/image.mjs` 负责，
   网格边长由调用方指定（它决定 soft token 预算）。

## 命令

```bash
node --test                                   # 39 条单测（纯函数 + 协议 + 子进程 E2E），零依赖
node scripts/probe.mjs --models <模型目录>     # Step 0/3-执行/5 探针；--runtime 或 MO_GALLERY_EMBEDDING_RUNTIME
node src/index.mjs                            # 以插件身份跑（stdin/stdout 说协议，日志走 stderr）
```

协议面（与 `faces@1` 同一套帧格式，`[4B 大端长度][1B 类型][负载]`）：

| 方法 | 状态 |
|---|---|
| `plugin.getManifest` | ✅ 原样回显 manifest |
| `embedding.getModelSpecs` | ✅ 交出文件/体积/sha256/许可/来源/维度/网格/前缀表，宿主据此下载 |
| `embedding.health` | ✅ 只查体积不算哈希（可频繁探活） |
| `embedding.text` / `embedding.image` | ✅ 出向量（`{embedding(单位向量), norm:1, dim}`）：文本按 `TASK_PROMPTS` 注入前缀后 `encode()`（分词器自带 `<bos>`/`<eos>`），图像按 `<|image>` + `<|image|>`×N + `<image|>` 装配序列、N 取视觉编码器实际 token 数；模型文件没就位时报 `MODEL_MISSING`、参数非法先报 `BAD_REQUEST` |

探针要的 5 个文件用设计文档 §8 附录 A 的命令取，或按 `src/models.mjs` 的 `MODEL_FILES` 自行 staging
（体积与 sha256 都写在那里，**sha256 是唯一权威口径**）。

## 不可协商的约定

1. **不用 fp16 计算精度。** 模型卡原文：fp16 会返回 NaN 或静默劣化的向量且不报错。当前 `q4` 产物
   已静态确认是「4bit 权重（`MatMulNBits`, block_size=32）+ fp32 激活」，图内 0 个 fp16 initializer；
   换档必须重新确认，探针会把 dtype 打出来。
2. **文本必须带任务前缀**（`TASK_PROMPTS`），图/视频/音频不加前缀；缺前缀不报错，只是检索变差。
3. **截断与归一化是一步**（`truncateAndNormalize`），query 与库内必须同维度；非有限值一律拒绝
   ——包括落在截断点之外的坏值（fp16 溢出的典型形态）。
4. **模块本身零 npm 依赖**：`onnxruntime-node` 由宿主供给；分词器的**解析库**同理——`@huggingface/tokenizers`
   v0.2.0 由宿主 staging 到只读 runtime 目录（`MO_GALLERY_EMBEDDING_RUNTIME`），插件按路径 import；
   `tokenizer.json` 本身是 32MB 的**语料文件**，跟权重一样走模型通道（`MO_GALLERY_EMBEDDING_MODELS`）。
   定档理由见设计文档 §4.4——插件包内永远不出现 `dependencies`。

## 未完成

- **查询路径与界面**：宿主侧的向量库与全库批处理已经落地，但「文本 query → 向量 → 与 FTS5
   混合排序」与索引进度/结果呈现还没接通（设计文档 §4.2/§4.7），所以资源库搜索框现在仍只走 FTS5 关键词
- Step 3 的**质量**部分：量化保真需要 fp32 参考向量（Python 侧），探针只覆盖执行与 dtype
- Step 4：中文召回与 FTS5 基线对照（需要样本集与 query 集）。`scripts/verify-embeddings.mjs`
   只做跨模态排序的 sanity（真实照片 × 三条 query，排序与模型卡一致），**不是召回率验收**
- 视频 / 音频模态未接线：`MULTIMODAL_TOKENS` 里已有 `<|video|>`/`<|audio|>` 字面量，
   但序列装配与编码器路径目前只做了图像

## 关于文案语言（别改错地方）

包内 `manifest.json` 的 `name`/`description` 按契约是**纯字符串**（宿主 `storage_plugins.Manifest.Name`
就是 `string`），它与仓库里其它插件一致（`faces`、`image-similarity` 包内也都是英文）。**界面语言的
国际化走市场索引 `index.json`，不走 manifest**：包内 manifest 躺在已发布的签名包里，改源码只对新发
版本生效，改索引却立刻生效；前端取用顺序是「索引优先、回落包内原文」（见
`frontend/src/pages/settings/StorageTab.tsx` 里 `installedPluginName` 的注释）。索引里写映射时
`zh` 与 `en` 必须同时给，否则 `npm run check` 会挡下。

**本插件的索引条目已经加好**（`index.json` 里的 `embedding`，`name: {zh: "语义检索", en: "Semantic
embedding"}`），所以插件页能显示中文，而且两步补齐都已按「顺序不能反」的约定走完：

1. **宿主先有启动路径**（已落地）：`storage_plugins/embedding.go` 照 `faces.go` 的形状准备数据目录、
   查配额、拼 `cleanEnv` 与能力参数，最后 `startPluginRuntimeFramed` 启动本插件，并通过
   `MO_GALLERY_EMBEDDING_MODELS`（模型目录，只读）与 `MO_GALLERY_EMBEDDING_RUNTIME`（原生 ONNX
   运行时 + 分词器解析库所在目录，只读）把两样东西交进来。
2. **打签名包并发布**（已落地）：五个平台键的 `url` / `sha256` / `size` 都指向 `embedding-v0.1.0`
   的签名资产，条目同时声明 `minDesktopVersion: "0.8.6"`——它声明的是**运行**本插件所需的最低
   Desktop 版本，低于它的客户端仍能在市场里看到条目，但安装会被拒并提示升级。

装得上、也起得来，而且**已经能产出向量**（分词器接线已完成，见上文实测数字）。仍然留在宿主侧的是
**查询路径与界面**（设计文档 §4.2/§4.7），不在这个插件的包里。

`description` 里刻意**不承诺耗时**：全库图像索引的规模（1 万张 ≈ 12 小时，见设计文档 §5.5）还没定档，
在触发策略确定前不要把它写进面向用户的文案。
