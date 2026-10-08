# Semantic embedding — `embedding@1`（EmbeddingGemma 2）

> **状态：spike 阶段，尚不可安装。** 宿主还没登记 `embedding@1` 域：`addons:onnx` 目前只发给
> `faces@1`（`storage_plugins/capabilities.go:43`），而且市场索引校验**明确拒绝**「声明
> `addons:onnx` 却没有 faces 贡献」的插件（`scripts/validate-index.mjs:124`）——所以这个插件
> 在契约改动（设计文档 §4.3，四处同改）落地前进不了索引。旧客户端遇到未知能力也会**直接拒绝安装**。
>
> 已完成：`manifest.json`、RPC 面（JSON-RPC over stdio + 二进制分帧）、规格常量、原生运行时加载、
> 两段式引擎、图像 patch 化预处理、模型 staging 脚本、Step 0 探针、34 条单测（含子进程 E2E）。
> **未完成**：分词器——`embedding.text` / `embedding.image` 因此如实回 `UNSUPPORTED`，不用猜出来的
> token 蒙向量（见设计文档 §4.4）。

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
node --test                                   # 34 条单测（纯函数 + 协议 + 子进程 E2E），零依赖
node scripts/probe.mjs --models <模型目录>     # Step 0/3-执行/5 探针；--runtime 或 MO_GALLERY_EMBEDDING_RUNTIME
node src/index.mjs                            # 以插件身份跑（stdin/stdout 说协议，日志走 stderr）
```

协议面（与 `faces@1` 同一套帧格式，`[4B 大端长度][1B 类型][负载]`）：

| 方法 | 状态 |
|---|---|
| `plugin.getManifest` | ✅ 原样回显 manifest |
| `embedding.getModelSpecs` | ✅ 交出文件/体积/sha256/许可/来源/维度/网格/前缀表，宿主据此下载 |
| `embedding.health` | ✅ 只查体积不算哈希（可频繁探活） |
| `embedding.text` / `embedding.image` | ⏳ 参数校验、前缀注入、分帧与 patch 化都跑通，最后一段**卡在分词器**，如实回 `UNSUPPORTED` |

探针要的 5 个文件用设计文档 §8 附录 A 的命令取，或按 `src/models.mjs` 的 `MODEL_FILES` 自行 staging
（体积与 sha256 都写在那里，**sha256 是唯一权威口径**）。

## 不可协商的约定

1. **不用 fp16 计算精度。** 模型卡原文：fp16 会返回 NaN 或静默劣化的向量且不报错。当前 `q4` 产物
   已静态确认是「4bit 权重（`MatMulNBits`, block_size=32）+ fp32 激活」，图内 0 个 fp16 initializer；
   换档必须重新确认，探针会把 dtype 打出来。
2. **文本必须带任务前缀**（`TASK_PROMPTS`），图/视频/音频不加前缀；缺前缀不报错，只是检索变差。
3. **截断与归一化是一步**（`truncateAndNormalize`），query 与库内必须同维度；非有限值一律拒绝
   ——包括落在截断点之外的坏值（fp16 溢出的典型形态）。
4. **模块本身零 npm 依赖**：`onnxruntime-node` 由宿主供给，分词器归属见设计文档 §4.4（待定）。

## 未完成

- **分词器**（唯一的功能性缺口）：需要 `tokenizer.json`（32MB，262k 词表）。归属（宿主 staging vs
  插件自带）见设计文档 §4.4；文本 encode 与图像序列装配都卡在这一步，所以 `embedding.text` /
  `embedding.image` 现在如实回 `UNSUPPORTED`，而不是拿猜出来的 token 蒙一个向量
- Step 3 的**质量**部分：量化保真需要 fp32 参考向量（Python 侧），探针只覆盖执行与 dtype
- Step 4：中文召回与 FTS5 基线对照（需要样本集与 query 集）
- 宿主侧：`embedding@1` 域的**校验**已落地，但**启动路径未实现**——宿主目前没有任何代码会去启动本插件

## 关于文案语言（别改错地方）

包内 `manifest.json` 的 `name`/`description` 按契约是**纯字符串**（宿主 `storage_plugins.Manifest.Name`
就是 `string`），它与仓库里其它插件一致（`faces`、`image-similarity` 包内也都是英文）。**界面语言的
国际化走市场索引 `index.json`，不走 manifest**：包内 manifest 躺在已发布的签名包里，改源码只对新发
版本生效，改索引却立刻生效；前端取用顺序是「索引优先、回落包内原文」（见
`frontend/src/pages/settings/StorageTab.tsx` 里 `installedPluginName` 的注释）。索引里写映射时
`zh` 与 `en` 必须同时给，否则 `npm run check` 会挡下。

**本插件的索引条目已经加好**（`index.json` 里的 `embedding`，`name: {zh: "语义检索", en: "Semantic
embedding"}`），所以插件页现在就能显示中文。但它的 `platforms` 是**空对象**——还没有签名 Release
资产，所以宿主会把它标成 `available=false` / **「当前平台暂无安装包」**：条目照常列出（名字是中英
双语的），安装按钮不可用。这是刻意的中间状态，不是遗漏。

补齐时要做两件事（**顺序不能反**）：

1. **宿主先有启动路径**：`embedding@1` 目前只落地了**校验**（`capabilities.go` 的
   `validateEmbeddingContribution`），没有任何代码会去启动本插件——`faces.go` 里那段准备目录、
   拼 `cleanEnv` 与能力参数、`startPluginRuntimeFramed` 的流程在 embedding 这边还不存在。
2. **再打签名包并发布**，然后把五个平台键的 `url` / `sha256` / `size` 填进索引条目的 `platforms`，
   同时按实际的宿主版本补上 `minDesktopVersion`（它声明的是**运行**本插件所需的最低 Desktop 版本，
   现在还没有那个版本，所以刻意留空——安装本来就被空的 `platforms` 挡住了，不需要它兜底）。

`description` 里刻意**不承诺耗时**：全库图像索引的规模（1 万张 ≈ 12 小时，见设计文档 §5.5）还没定档，
在触发策略确定前不要把它写进面向用户的文案。
