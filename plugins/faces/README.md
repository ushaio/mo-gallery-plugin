# Faces（`faces@1`）

MO Gallery 资源库的人脸插件：**YuNet 检测 + SFace 特征**，全部在本机跑，不出网、不上传。

插件只做算法。人物分组、人工改名/合并、墓碑、素材关联与全部界面都留在宿主
（`emulsion-desktop-v3`），所以卸载插件不会丢任何「谁是谁」的数据。

## 它怎么和宿主配合

| 方向 | 内容 |
|---|---|
| 宿主 → 插件 | 启动一次常驻子进程，调 `plugin.getManifest` 握手、`faces.getModelSpecs` 取模型声明，然后每张图调 `face.detect` + `face.embed` |
| 插件 → 宿主 | 检测框与五点关键点、未归一化的 128 维特征；模型清单（文件名、体积、sha256、许可、来源） |
| 宿主自己干 | 下载并校验模型、解码/摆正/缩放照片、几何过滤、写库、聚类、人物界面 |

模型权重**不在插件包里**：宿主把它们放在自己的全局目录（`<配置目录>/models/face/`），
通过 `MO_GALLERY_FACE_MODELS` + `--allow-fs-read=<modelsDir>` 交给插件。插件只校验
「在不在、多大、sha256 对不对」，缺了就报 `MODEL_MISSING`。

## 协议

`faces@1` 是版本化域，传输是 **JSON-RPC 2.0 + 二进制帧**（宿主 `storage_plugins/frames.go`）：

```
每帧 [4B 大端长度][1B 类型][负载]，长度包含类型字节
  type 0 控制帧 —— JSON-RPC 信封（无结尾换行）
  type 1 数据帧 —— [1B idLen][id][4B 大端 offset][原始字节]
```

像素不走 JSON：控制帧在 `params.image.blob = {id, length}` 里声明长度，紧随其后的数据帧带
字节（1024×1024 RGB8 = 3 MiB，base64 会顶到宿主的行上限并多付 1/3 编解码）。攒够声明长度
才执行推理，攒的过程中不回任何东西。

| 方法 | 入参 | 出参 |
|---|---|---|
| `plugin.getManifest` | — | 本目录的 `manifest.json` |
| `faces.getModelSpecs` | — | `{protocol:1, engine:{name,version}, models:[…]}` |
| `faces.health` | — | `{engine, modelsDir, models:[{id,present,sizeBytes,expectedSizeBytes}], cache}` |
| `face.detect` | `{image:{width,height,blob}, scoreThreshold?, nmsThreshold?, topK?}` + 数据帧 | `{width, height, paddedWidth, paddedHeight, faces:[{score,x,y,width,height,landmarks[5][2]}]}` |
| `face.embed` | `{image:{…}, landmarks:[[x,y]×5]}` + 数据帧 | `{embedding[128], norm}`（**未归一化**，归一化由宿主做） |

坐标一律是**收到缓冲区的像素坐标、左上原点**；每边上限 1024 px（宿主先降采样，插件对超限
尺寸回 `DECODE_FAILED`）。五点顺序：右眼 / 左眼 / 鼻尖 / 右嘴角 / 左嘴角。

### 错误码

前五个与宿主 `local_library` 的 `FaceInferenceCode*` 逐字对应——宿主用它们区分「这张照片
有问题」（只跳过当前素材）与「这台机器的人脸推理不可用」（连续出现就停索引），所以不能改名：

`MODEL_MISSING`、`MODEL_HASH_MISMATCH`、`DECODE_FAILED`、`INFER_FAILED`、`UNSUPPORTED`、
`BAD_REQUEST`、`INTERNAL`。

一条坏请求只回错误、不会毒化进程；只有帧级损坏（长度/类型非法，流无法重新对齐）才退出。

## 权限

```json
"permissions": ["addons:onnx"]
```

只此一条，含义是允许加载 ONNX Runtime 原生扩展（`--allow-addons`，`CAPABILITIES.md` 里
明确写了这是策略层的放宽）。插件**不申请**任何 `sqlite:*`：它不读资源库数据库、也没有需要
落盘的数据，因此宿主不会给它插件数据目录，也不会授予任何写权限。

## 算法为什么值得信任

算法是从 desktop 仓库的内置 sidecar（`runtime/inference`）原样搬过来的，三处容易被「顺手
修正」的约定都保留了：YuNet 吃 **BGR 平面**、SFace 吃 **RGB 平面**、`alignFace` 越界读 0
（BORDER_CONSTANT，不复制边缘像素）、模板均值用 C++ 四舍五入的 56.0262 / 71.9008。
`tests/sidecar-parity.test.mjs` 用同一批像素同时喂给旧 sidecar 与本插件，逐字段比对检测框
（< 1e-9）与 128 维特征（< 1e-6，cosine > 0.9999999）。

## 开发

```bash
npm test            # 全部：分帧 + 协议 + 几何 + 端到端（有模型/运行时则跑真推理）
npm run test:unit   # 只跑不需要模型与 onnxruntime 的部分
npm run test:e2e    # 真子进程 + 真权限参数 + 真模型
```

| 文件 | 覆盖 |
|---|---|
| `tests/frames.test.mjs` | 分帧格式、增量解码、边界与失败语义 |
| `tests/protocol.test.mjs` | 握手、模型声明、健康、负载装配、参数校验、错误码（替身引擎） |
| `tests/face.test.mjs` | 几何/张量数学（OpenCV 基准张量，无需 ONNX） |
| `tests/contract.test.mjs` | 真子进程 + `--experimental-permission` + 真模型，含跨进程确定性 |
| `tests/sidecar-parity.test.mjs` | 与旧内置 sidecar 的逐位等价（sidecar 删除后自动跳过） |

端到端测试默认读取：

- 模型目录：`MO_GALLERY_FACE_MODELS`，否则 `%APPDATA%\mo-gallery-desktop\models\face`
- 原生运行时：`MO_GALLERY_FACE_RUNTIME`，否则工作区里的 `emulsion-desktop-v3/runtime/inference`

两者或缺其一，端到端用例自动跳过（单元与几何用例仍会跑）。

真实人脸的检出率门禁不在本仓库：那需要用户自己的照片，属于宿主侧的
`MO_GALLERY_FACE_SMOKE` 冒烟测试。

## 还没做的

- **市场索引**：本仓库规则是「只登记已发布签名安装包」，所以 `index.json` 里还没有 `faces`
  条目；签名包发布后再补（分类归在「资源库与检索」`library`）。
- **插件侧缓存**：`faces@1` 的请求里没有资产 id、也没有内容哈希，落盘缓存无法被稳定地键
  索引，而且跳过与重算的判定权在宿主（`face_index_status` + 内容哈希门），所以插件刻意不建
  缓存——`faces.health.cache` 里如实汇报的只有「已校验过哈希的模型文件条数」。
