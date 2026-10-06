# Changelog

本文件记录 **mo-gallery-plugin**（插件市场索引 `index.json` + 官方插件源码 `plugins/`）的发布更新日志；每个版本一个条目，包含 `feat`（新功能）与 `fix`（问题修复）两部分，条目使用有序列表。

## 写法约定

1. 本仓库的版本以**插件**为单位（如 `s3-compatible`、`webdav`、`github`），索引整体版本另计；条目请标注插件名与版本，例如 `s3-compatible v0.1.3`。
2. 开发中的改动先写在文件顶部的 `[Unreleased]` 下；发布时把它改成 `## [<插件名> v<x.y.z>] - YYYY-MM-DD`，并在最上方新增一个空的 `## [Unreleased]`。
3. 条目按 Conventional Commits 归类：`feat:` 归 `feat`，`fix:` 归 `fix`；索引收录、签名包发布等流程改动只有在影响使用者时才记入。
4. 一条 = 一个用户可感知的变化；同一功能的多条提交合并成一条，不要直接照抄 commit message。
5. `feat` 与 `fix` 两部分始终保留；确实没有对应改动时写 `1. 暂无`。
6. 发布前仍须执行 `npm run check`（发布资产用 `npm run check:assets`）。

> 本文件于 2026-09-18 启用，不回溯此前的历史。下面的 `[Unreleased]` 收录启用时仍在开发中（2026-09-15 起提交）的改动。

## [Unreleased]

### feat

1. 市场索引新增可选的 `category` 字段，分栏词表改由仓库根目录的 `categories.json` 驱动（`categories.json` + `schema/categories.schema.json` + `schema/index.schema.json` + `scripts/validate-index.mjs` + `CONTRIBUTING.md`）：客户端把 `categories.json` 直接当**分类 API** 拉取——栏名取 `name` 里当前界面语言的键、顺序就是数组顺序，所以**加一栏只要在 GitHub 上改这一份文件，不用发客户端版本**。`plugins[].category` 收字符串与字符串数组，写数组表示一个插件同时挂在多栏下（每一栏里各列一次）；词表本次扩到 10 栏，新增「图片编辑」`image-editing`、「格式扩展」`format`、「AI 工具」`ai`、「生产效率」`productivity`，并把 `image-preview` / `library` / `storage` 的能力域兜底映射从客户端搬进 `categories.json` 的 `domains`（插件没写分类时按它反推分栏）。`npm run check` 现在同时校验两份文件：引用未声明的分类、同一插件里重复的分类、被两栏同时认领的能力域都会失败；现有三个插件（`s3-compatible`、`github`、`webdav`）标为 `storage`，`hasselblad-3fr` 标为 `image` + `format`。
1. `s3-compatible` v0.2.0：新增插件自带的 web 配置界面（`ui@1`，`ui/index.html` + `src/ui.ts`）。相比按 `configSchema` 生成的表单，界面能表达服务商预设（R2 / AWS / 其他 S3）、按条件显示的字段（`publicUrl` 只在 `urlMode=public` 时出现、签名有效期只在 `signed` 时出现），以及真正走插件进程的「测试连接」；版式与宿主自己的存储源表单对齐——字段区在 ≥640px 时两列、窗口收窄到最小宽度时回落单列，输入框统一 32px 高，端点与名称这类长字段横跨整行。界面在无 same-origin、CSP 封禁全部网络的沙箱 iframe 里运行，只能读写当前这一个数据源的配置；凭据只写不读，空凭据输入会被宿主丢弃，因此保存表单不会误清已存的密钥。
1. `hasselblad-3fr` v0.1.0：收录市场索引（分栏「图片处理」+「格式扩展」，`category: ["image", "format"]`）。插件从经典 TIFF 包装的 `.3fr` 里提取**已有的连续 JPEG 预览范围**，贡献 `image-preview@1` 的 `preview` 能力、`permissions: []`，让资源库能为哈苏 3FR 生成缩略图与详情预览；它不是 RAW 显影器（不做去马赛克/传感器解码）。宿主侧需支持 `image-preview@1`。

1. 市场索引的 `name` 与 `description` 支持国际化（`schema/index.schema.json` + `scripts/validate-index.mjs` + `index.json` + `CONTRIBUTING.md` + `README.md`）：字段既可以直接写一个字符串（各界面语言共用它，旧索引与第三方索引不受影响），也可以写成「界面语言代码 → 文案」的映射，由客户端按当前界面语言取用、取不到再退回另一种。映射必须同时给出 `zh` 与 `en` —— 只给一种时另一种语言的界面会直接显示外语，而作者在索引里看不出来，所以 `npm run check` 会挡住。现有四个插件的中文名称与介绍已补齐。

### fix

1. `s3-compatible`：流式传输改为按需计算校验和（`requestChecksumCalculation=WHEN_REQUIRED`），修复部分 S3 兼容存储的流式上传失败（`5960537`）
2. `s3-compatible`：修正 SDK 依赖路径（`emulsion-desktop` → `emulsion-desktop-v3`），此前指向工作区里的空目录，`pnpm install` 后无法解析 `@mo-gallery/plugin-sdk`
3. `hasselblad-3fr`：修正 SDK 依赖路径（`emulsion-desktop` → `emulsion-desktop-v3`）。该目录已归档到 `archive/`，原路径下没有可解析的 `@mo-gallery/plugin-sdk`，导致 `pnpm install` 装不上依赖、无法构建发布包
