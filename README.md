# Busy Magpie

magpie 的**路由桌面插件**：把「模型 / 路由」页里那条实时链路，做成一张透明、鼠标点击可以穿透的桌面卡片。

- **Windows 10/11** 和 **macOS 12+** 同一套代码。
- **不修改 magpie**：只读取 magpie 本机的 `GET /v1/magpie/trace`，不改源码、不改配置。
- **不拦截鼠标**：卡片正常显示时使用系统级 click-through，点击会落到下面的窗口。
- **同时显示所有正在执行的 Agent**：两个及以上请求进行中时，左侧是各个 Agent，中央是同一个 magpie，虚线收束再分发到右侧各自被选中的账号。卡片尺寸不随 Agent 数变化，Agent 变多时只压缩上半部视图；需要更大或更小时可拖动右下角手动调整，尺寸会记住。
- 托盘菜单可以调整位置、开关置顶、隐藏账号、调整不透明度、重新连接。

## 它长什么样

### 一个请求

```
Codex  ┈┈┈┈  magpie  ┈┈┈┈  OpenAI
gpt-6-astra   127.0.0.1:3425   j•••@g•••.com
                              回答中…
```

下方是「最近一个请求是怎么路由的」三行说明，以及请求 / 改道 / Agent 错误统计。

### 两个及以上请求

```
DeepSeek Harness ┈┐
                  ├─→  magpie  ─→  team
Codex            ┈┘              OpenAI
```

所有进行中的请求同时展开：Agent 在左、账号在右，彩色虚线从每个 Agent 收束到同一个中央 magpie，再分发到各自的账号。账号列保持自己的顺序，不跟 Agent 行对齐，所以线路会像原版一样在 magpie 处交叉。默认窗口为 632×432，可以拖动任意边框或四角手动调整大小，尺寸会记住；Agent 数量变化不会自动改窗口大小。上半部的路由视图随 Agent 数收紧，下面的说明、统计和「最近一个请求」区域始终留在原位，不会因为单请求/多请求切换而消失或移动。请求很多时节点会隐藏次要信息，保证每个 Agent 仍在画面里。

顶部有一个 token 胶囊：读取 magpie 的 `/v1/magpie/usage`，显示近 30 天的**总 token**（输入 + 输出 + 缓存读/写），下面的细条是这段时间的缓存命中率。单请求的账号卡片仍会显示这一条「输出 324 · 缓存 98%」的明细。

请求进行中时，小喜鹊会沿着实际的虚线路径，从 Agent 飞到中央 magpie、穿过 magpie，再飞到被选中的账号；回答时再飞回来，喙上带着该 Agent 颜色的小点。它不参与布局，也不影响点击穿透。

## 运行

需要 Node.js 20+，以及本机正在运行的 magpie（默认网关 `127.0.0.1:3425`）。

```bash
npm install
npm start
```

`npm install` 只会把 Electron 装进**当前项目的 `node_modules`**，不执行全局安装，也不改系统 PATH。启动后没有任务栏窗口，只有桌面卡片和托盘图标。首次运行会在右下角出现。

移动位置有两种方式：

- **长按卡片顶部**（顶部中间有一排小圆点）约 0.4 秒，等光标变成抓手后直接拖动；松手即恢复点击穿透。
- 托盘菜单 →「调整位置…」，整张卡片进入调整模式；按 Esc 完成。

调整大小：

- 鼠标移到卡片**任意边框或四个角**，出现缩放光标后直接拖动；松手会保存宽高。
- 最小 600×432，最大不超过当前屏幕可用区域。
- 正常状态只有顶部约 28px 的窄条和边框/四角约 8px 的窄带会在鼠标悬停时临时接收指针，卡片其余区域始终点击穿透。

如果不想保留依赖：删掉项目内的 `node_modules` 和 `dist` 即可，Electron 不会残留在全局。

### 托盘菜单

| 菜单 | 作用 |
| --- | --- |
| 显示 / 隐藏桌面插件 | 显示或隐藏卡片 |
| 总在最前 | 是否永远盖在其他窗口上方 |
| 隐藏账号名称 | 默认开启；邮箱和 Key 会打码，服务商名称保留 |
| 不透明度 | 100% / 92% / 84% / 75% |
| 设置… | 在当前卡片下方展开设置，修改置顶、打码、透明度和网关 |
| 调整位置… | 临时关闭穿透，整张卡片可拖动；30 秒后或按 Esc 自动恢复 |
| 重新连接 | 重新读取网关地址并连接 |
| 打开设置文件 | 在文件管理器中定位 `settings.json` |
| 退出 | 完全退出 |

macOS 上托盘图标在菜单栏；应用是 `LSUIElement`，不会出现在 Dock 和 Cmd+Tab。

### 设置面板

托盘菜单 →「设置…」不会另开窗口，而是把当前卡片向下展开，在原面板下面显示设置内容；保存或关闭后自动缩回原来的尺寸。设置期间卡片整体可交互，关闭后恢复点击穿透。

可以直接改：

- 总在最前
- 隐藏账号名称
- 不透明度
- 网关地址（留空自动检测）

面板底部可以查看当前 `settings.json` 原文、打开它所在的文件夹。保存后会立即应用并写回文件。窗口宽高通过拖动卡片边框调整，会写入同一个文件。

`settings.json` 的字段：

| 字段 | 含义 |
| --- | --- |
| `topmost` | 是否总在最前 |
| `maskAccounts` | 是否隐藏邮箱 / Key |
| `opacity` | 0.4 – 1 |
| `left` / `top` | 窗口位置 |
| `width` / `height` | 窗口尺寸 |
| `gateway` | 固定网关；`null` 表示自动检测 |

## 构建安装包

```bash
# Windows：NSIS 安装包（x64）
npm run dist:win

# macOS：dmg + zip（x64 / arm64）
# 必须在 macOS 上执行
npm run dist:mac
```

产物在 `dist/`。也可以直接 `npm run pack` 生成未打包目录。

macOS 构建默认**未签名、未公证**。首次打开如果被 Gatekeeper 拦截，右键 → 打开；或在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Busy Magpie.app"
```

跨平台打包由 `.github/workflows/build.yml` 在 `windows-latest` 与 `macos-latest` 上分别完成。

## 网关地址

按以下顺序解析：

1. `BUSY_MAGPIE_GATEWAY` 环境变量
2. `MAGPIE_ADDR` 环境变量
3. `~/.config/magpie/settings.json` 里的 `port`
4. `127.0.0.1:3425`

`MAGPIE_ADDR=0.0.0.0:3425` 这类监听地址会自动改连 `127.0.0.1:3425`。也可以在托盘菜单的「重新连接」前，把 `gateway` 写进本插件的 `settings.json`：

```json
{
  "gateway": "http://127.0.0.1:3425",
  "maskAccounts": true,
  "topmost": true,
  "opacity": 1
}
```

配置文件位置：

- Windows：`%APPDATA%\Busy Magpie\settings.json`
- macOS：`~/Library/Application Support/Busy Magpie/settings.json`

日志在同目录的 `busy-magpie.log`，只记录连接失败和崩溃，不记录请求内容、账号或 Key。

## 为什么不是 magpie 的 GUI 插件

magpie 的 GUI 插件运行在它自己的窗口里，无法创建一个跨应用的透明、点击穿透的桌面层；而本项目又要求不修改 magpie。因此它是一个独立的小程序：

```
magpie (本机 :3425)
   │  GET /v1/magpie/trace  (long poll)
   ▼
Electron 主进程
   │  IPC
   ▼
透明 BrowserWindow（渲染层只做展示）
```

渲染层没有 Node 权限，也不直接访问网络；所有 trace 读取都在主进程完成，避免 CORS，也不把账号信息暴露给页面以外的内容。

## 开发

```bash
npm run dev            # 打开开发者工具
npm start -- --layout  # 启动即进入调整位置模式
```

本地模拟数据（不需要真实请求）：

```bash
# 单个 OpenAI 请求，往复在回答中 / 已回答
python tools/mock_trace.py 3499
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3499 npm start

# 多个并发 Agent
python tools/mock_multi.py 3500
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start
```

调试渲染层：

```bash
npx electron . --remote-debugging-port=9223
node tools/cdp.mjs eval "document.body.innerText"
node tools/cdp.mjs shot "artifacts/fan.png"
```

结构：

```
src/main.js            窗口、托盘、长轮询、固定尺寸
src/preload.js         contextBridge 白名单
web/app.js             渲染、多条路径的 SVG 虚线、飞鸟
web/presenter.js       只根据 trace 生成文案
web/styles.css         透明卡片样式
web/index.html         卡片结构
assets/                magpie 鸟标、OpenAI 图标、托盘/应用图标
tools/                 图标生成、模拟 trace、CDP 检查、Windows 打包
```

## 限制

- 只展示本机 magpie 网关的 trace；远程 magpie 的 trace 由 magpie 自己限制为本机读取。
- 窗口尺寸固定；多请求时上半部会压缩节点，超过约 12 个并发时会隐藏更多文本，极小节点只保留 Agent/账号名称。
- 不修改 magpie，因此不会在 magpie 的「路由」页里增加额外入口；入口是托盘图标。
