# OpenCut Web 启动配置（精简版编辑器）

本项目使用 **Bun + Turborepo + Next.js**。当前代码已裁剪为仅保留在线视频编辑核心能力（导入/时间线/预览/导出等），因此大部分云/账号/内容站相关环境变量 **不再需要**。

## 前置条件

- Node.js（建议与仓库一致的较新版本即可）
- Bun（用于 workspace 安装与运行）

安装 Bun（若你没有 bun 命令）：

```bash
npm i -g bun
```

## 安装依赖

在仓库根目录执行：

```bash
bun install
```

## 启动开发环境（推荐）

在仓库根目录执行：

```bash
bun run dev:web
```

默认地址：
- `http://localhost:3000`

## 生产构建 / 启动

```bash
bun run build:web
cd apps/web
bun run start
```

## 环境变量（最小集）

### 必需

当前最小编辑器形态 **无需任何必需的服务端密钥** 才能在本地打开编辑器。

### 可选（仅影响 SEO/metadata）

- **`NEXT_PUBLIC_SITE_URL`**：站点 URL（用于 `metadataBase` 等）。不设置一般也能运行，但建议本地开发设为：

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## .env 文件建议

仓库里存在示例文件：`apps/web/.env`（包含历史上用于账号/云/内容站的变量）。

本地开发建议创建：

- `apps/web/.env.local`（Next.js 会自动读取）

最小内容示例：

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## 常见问题

### 1) `bun: command not found`

```bash
npm i -g bun
```

### 2) 端口被占用

Next 会提示并自动换端口；你也可以自行指定：

```bash
cd apps/web
bun run dev -- -p 3001
```

### 3) 构建时报找不到某些依赖

通常是仍有残留 `import` 指向已删包。建议先跑：

```bash
cd apps/web
bun run lint
```

