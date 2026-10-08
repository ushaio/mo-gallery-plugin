# 插件能力声明（`manifest.permissions`）

`permissions` 回答的是「插件的**进程**需要什么」，不是「插件的界面能做什么」。它有两个作用：

1. **安装闸门**：宿主的安装/加载校验会拒绝未知能力，并在缺失依赖能力时拒绝启动对应域。
2. **执行边界**：宿主按声明拼出 Node 的启动参数，把插件进程关进它自己声明的那点文件系统权限里。

索引 `index.json` 里的 `plugins[].permissions` 是**安装前的预览**（让用户在点「安装」之前看清楚权限，并让市场页能列出权限说明）；权威来源始终是包内 `manifest.json`，宿主安装时会以包内为准复核。

> **落地进度**：本文档与市场侧校验（`schema/index.schema.json` + `npm run check`）已经生效；
> 宿主侧的「登记表白名单 + 按声明拼启动参数」随 `faces@1` 一起落地，实现位置与现状见
> `emulsion-desktop-v3/docs/plugin-capabilities.md`。在宿主侧落地前，写错的能力 id 会被市场
> 校验挡在入口，但直接安装本地未签名包时不会被拒绝。

## 能力 id 的写法

```text
<namespace>:<subject>[:<access>]
```

全小写 ASCII、用 `:` 分段。**当前 v1 只有下面这张表里的取值**；写别的一律按「未知能力」拒绝安装，错误信息会点名具体 id（用户看到的是「需要更新 Desktop」）。没有声明任何能力时，插件进程只有包目录的只读权限，既不能写文件、也读不到任何宿主数据。

| 能力 id | 作用域 | 读写 | 宿主如何执行 |
| --- | --- | --- | --- |
| `network:configured-endpoint` | 插件进程出网 | — | 声明式：只允许访问「用户在插件设置里配置的远端地址」。宿主的 Node 权限模型不拦网络，这条靠凭据注入、地址校验与市场评审共同约束。 |
| `sqlite:data:read` | 插件私有数据目录 `<data>/` | 只读 | 启动参数加 `--allow-fs-read=<data>`，并注入环境变量 `MO_GALLERY_PLUGIN_DATA`。 |
| `sqlite:data:read-write` | 插件私有数据目录 `<data>/` | 读写 | 启动参数加 `--allow-fs-read=<data> --allow-fs-write=<data>`，并注入 `MO_GALLERY_PLUGIN_DATA`。 |
| `sqlite:library:read` | 当前打开的资源库 | 只读 | 启动参数加 `--allow-fs-read=<库根>/.mo-gallery`（**不加写权限**），并注入 `MO_GALLERY_LIBRARY_DB`。插件必须用只读方式打开（`new DatabaseSync(path, { readOnly: true })` 或 `file:…?mode=ro`）。 |
| `addons:onnx` | 插件进程加载原生扩展 | — | 启动参数加 `--allow-addons`。只发给**已通过评审、且宿主侧契约写在 `capabilities.go` 里的域**——当前是 `faces@1`（人脸检测/特征）与 `embedding@1`（语义向量）。它会加载 ONNX Runtime 之类的原生模块，Node 自己也会警告这会让权限模型失效，所以是逐插件授予，不是通用开关；新增一个域必须宿主与市场两侧同改。 |

两点约定：

- **没有 `sqlite:data:write`**：SQLite 的任何写事务都要先读 schema、journal 与 WAL，所以「能写」必然「能读」，写权限一律写成 `read-write`。
- **没有 `sqlite:library:write`**：宿主是资源库 schema、迁移、墓碑与派生键的权威，插件不得写宿主资源库。写请求会因文件权限直接失败，宿主也不接受这类声明。

### 数据目录

`<data>` = `<用户配置目录>/storage-plugins/<插件 id>/data/`。

- 按**插件**而不是按版本划分：插件升级、回滚都复用同一份数据，`.../<插件 id>/<版本>/` 只放代码。
- 卸载默认**保留**数据（并在界面提示）；用户可在插件设置里「清除插件数据」，重装同一 id 时接着用。
- 插件库归插件自己管：schema 迁移、损坏恢复、清理逻辑都由插件实现，宿主不读、不修、不迁移。

### 可选的范围声明块 `sqlite`

`permissions` 说明「能不能写」，`sqlite` 块补充「写在哪、写多大」，供市场页与评审阅读：

```json
{
  "permissions": ["sqlite:data:read-write", "addons:onnx"],
  "sqlite": {
    "databases": ["faces.sqlite"],
    "quotaBytes": 268435456
  }
}
```

- `databases`：插件会创建的库文件名（最多 8 个），必须落在数据目录里、扩展名用 `.sqlite` / `.db` / `.sqlite3`。用于让用户和评审知道插件会写几个库、叫什么。
- `quotaBytes`：请求的数据目录上限（1 MiB – 1 GiB，省略时按宿主默认 256 MiB）。超出上限时宿主会拒绝启动或终止进程。
- 一致性：出现该块却没声明任何 `sqlite:` 能力会被拒绝安装；声明了能力但不写该块则按宿主默认值走。
- 写在哪：包内 `manifest.json` 与索引条目里都可以写（同形）。**权威是包内那份**，索引里的镜像供市场页与安装确认页在装之前就把「会写哪几个库、要多大空间」摆给用户看；`npm run check` 对索引里的镜像做与包内相同的校验。

## 插件库的使用要求

以下是收录进市场时会被检查的约定：

1. **能从资源库重建**：插件库只应存算法私有数据（特征向量、算法版本、缓存索引、分组草案）。照片原图与派生图必须走 `host.transfer`，不得存进插件库；凭据必须走宿主的凭据库，不得落盘到插件数据目录。
2. **前向迁移**：用 `PRAGMA user_version` 记录 schema 版本。只允许前向迁移；读到自己不认识的、更高的版本时必须**拒绝工作**并报错（这会发生在新版插件 → 旧版插件回滚时），不能拿旧代码去写新 schema。
3. **损坏自愈**：启动时做 `PRAGMA quick_check`（或 `integrity_check`），失败就把文件重命名为 `<name>.corrupt-<UTC 时间戳>` 后重建。任何情况下都不要指望宿主替你修复。
4. **并发**：建议 `journal_mode=WAL` 并设置 `PRAGMA busy_timeout`。同一个库同时只有一个插件进程写；插件不得让宿主或另一个插件同时打开它。
5. **不放代码**：数据目录不是第二个代码分发通道，不得写入可执行文件或模块文件；包签名只覆盖安装时校验过的内容。
6. **读资源库（`sqlite:library:read`）必须说明用途**：这个能力会暴露资源库的元数据（资产路径、标签、分组等），属于隐私敏感项，PR 里要写清楚读什么、为什么主机的插件契约（`library@1` / `faces@1`）给不了同样的信息。默认结论是「不需要」。

## 索引里的镜像字段

`index.json` 的 `plugins[].permissions` 与包内 `manifest.json` 的 `permissions` 同形：

- 字符串数组，最多 8 个、不得重复、只能取上表的 id。
- 用途是市场页展示与安装前预览；**权威仍是包内 manifest**，两者不一致的插件不进索引。
- `npm run check` 会拒绝：未知 id、重复项、空数组（不要写 `"permissions": []`，直接省略字段）、以及在没声明 `faces@1`/`embedding@1` 贡献时声明 `addons:onnx`；索引里的 `sqlite` 镜像同样按 `databases`（≤8、扩展名限定 `/\.(sqlite|db|sqlite3)$/`）与 `quotaBytes`（1 MiB – 1 GiB）校验，且没有 `sqlite:` 能力时不许出现。

## 界面上的说明文案

市场页与安装确认页按 id 取下面这两句（客户端按界面语言选）：

| 能力 id | 中文 | English |
| --- | --- | --- |
| `network:configured-endpoint` | 访问你为该插件配置的远端地址 | Reaches the endpoint you configure for this plugin |
| `sqlite:data:read` | 读取插件自己的数据（只读） | Reads this plugin's own data (read-only) |
| `sqlite:data:read-write` | 读写插件自己的数据 | Reads and writes this plugin's own data |
| `sqlite:library:read` | 读取资源库元数据（只读） | Reads library metadata (read-only) |
| `addons:onnx` | 加载原生推理模块（ONNX） | Loads native inference modules (ONNX) |
## 新增能力 id 的流程

新能力要**两边同时改**，并走一次安全评审：

1. 宿主 `emulsion-desktop-v3`：能力白名单与执行方式（拼启动参数、准备目录、注入环境变量）落在 `storage_plugins/catalog.go`（`validateManifest` / `normalizeManifest`）与 `storage_plugins/runtime_resolver.go`、`storage_plugins/library.go`，见 `docs/plugin-capabilities.md`。
2. 本仓库：本文档的表格 + 界面文案 + `schema/index.schema.json` + `scripts/validate-index.mjs`。

旧客户端遇到未知能力会直接拒绝安装，所以使用新能力的插件必须在索引的 `description` 里写明所需的 Desktop 版本；`coreApiVersion` 目前固定为 `1`，它表达的是 manifest 结构版本，不是能力集合版本。
