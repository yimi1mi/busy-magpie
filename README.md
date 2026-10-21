# Busy Magpie

**magpie 实时路由桌面挂件**

**A transparent, click-through live routing perch for your desktop.**

一张透明、无边框、鼠标可以穿透的实时卡片。它读取 magpie 本机 trace，显示当前 Agent 经过了哪些路由、最终落到哪个账号，以及这段时间用了多少 token。

A transparent, borderless, click-through card that reads magpie's local trace and shows which routes each agent took, which account it landed on, and the total tokens used.

[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%C2%B7%20macOS%2012%2B-4b465c?style=flat-square)](#)
[![electron](https://img.shields.io/badge/Electron-39-8f7cff?style=flat-square)](https://www.electronjs.org/)
[![license](https://img.shields.io/badge/license-MIT-61d7e7?style=flat-square)](./LICENSE)

![Busy Magpie 多 Agent 路由视图](./docs/screenshots/multi.png)

> 截图中为本地模拟数据，账号已打码。

## 为什么是它

magpie 的「路由」页很好看，但它只在 magpie 自己的窗口里。Busy Magpie 把同一段实时链路变成一个常驻桌面的小层：

- **透明、无边框**，不挡桌面。
- **点击穿透**：正常状态下鼠标点击会落到下面的窗口，不抢焦点。
- **不修改 magpie**：只读取本机的 `/v1/magpie/trace` 和 `/v1/magpie/usage`。
- **同时显示所有正在执行的 Agent**：Agent 在左，magpie 在中间，账号在右；线路在 magpie 处交叉。
- **不随 Agent 数量变高变矮**：窗口尺寸稳定，只有上半部视图收紧；需要更大或更小时手动拖边框。
- **总 token + 逐位滚动 + 单击换窗口**：读取 magpie usage，单击在 今日 / 7 天 / 30 天 / 全部 之间循环。
- **设置直接在当前面板展开**，保存后缩回，不额外弹窗。

## 作为 magpie 插件

这个仓库同时是一个 **magpie 启动器插件**。安装它不会替换桌面卡片，而是在 magpie 第一次加载插件时，把已经安装的 Busy Magpie 桌面卡片启动起来：

```bash
magpie plugin add github:yimi1mi/busy-magpie
```

工作方式：

- 插件入口是 `plugin/launch.hooks.mjs`，在 `package.json` 的 `magpie.hooks` 里声明。
- magpie 第一次用到插件宿主时（通常是第一个 Agent 请求），查找已安装的 `Busy Magpie.exe` 并启动。
- 没安装时会自动从 GitHub 最新 release 下载安装包，校验 SHA-256 后静默安装到 `%LOCALAPPDATA%\Programs\Busy Magpie`，再启动。设置 `BUSY_MAGPIE_NO_INSTALL=1` 可以关闭自动安装。
- 下载开始、开始安装、安装完成/失败时都会发一条系统通知（Windows 用通知气泡，macOS 用通知中心）。如果系统开了专注模式，通知可能被折叠；插件日志里仍有 `[busy-magpie]` 记录。
- `plugin/server.mjs` 是一个空 provider stub，避免 magpie 把 Electron 主进程当成供应商插件加载。
- 如果安装在非默认目录，设置 `BUSY_MAGPIE_APP` 指向 `Busy Magpie.exe` 后重启 magpie：

```powershell
setx BUSY_MAGPIE_APP "D:\Apps\Busy Magpie\Busy Magpie.exe"
```

插件只负责启动桌面层；透明穿透、实时 trace 和所有界面仍然由 Electron 应用提供。magpie 的插件页面运行在沙盒 iframe 里，既拿不到实时 trace，也不能创建跨应用的透明窗口，所以这里采用启动器，而不是页面插件。

版本号取自 `package.json` 的 `version`（当前 `v1.3.4`）：magpie 的插件列表会显示它，桌面卡片右上角也会显示同一个版本；设置面板标题同样显示版本。

## 截图

### 一个请求

![单请求](./docs/screenshots/single.png)

单个请求时保留大号路由舞台，下方是「最近一个请求是怎么路由的」和请求 / 改道 / 错误统计。

### 多个 Agent

![多 Agent](./docs/screenshots/multi.png)

两个及以上请求同时展开：每个 Agent 一条链路，全部收束到同一个 magpie，再分发到各自账号。账号列保持自己的顺序，线路会自然交叉。

### 设置

![设置面板](./docs/screenshots/settings.png)

设置不是独立窗口，而是从当前卡片下方展开；关闭或保存后带缓动缩回。

### 关于与更新

![关于与更新](./docs/screenshots/update.png)

点右上角版本号打开。应用更新和启动器插件更新分开处理：应用可以直接更新，插件去 magpie 插件中心更新。

## 快速开始

### 直接运行源码

需要 Node.js 20+，以及本机正在运行的 magpie（默认 `127.0.0.1:3425`）。

```bash
npm install
npm start
```

`npm install` 只会把 Electron 装进当前项目的 `node_modules`，不会全局安装，也不会改系统 PATH。启动后没有任务栏窗口，只有桌面卡片和托盘图标。

### 构建安装包

```bash
# Windows：NSIS 安装包（x64）
npm run dist:win

# macOS：dmg + zip（x64 / arm64）
# 必须在 macOS 上执行
npm run dist:mac
```

产物在 `dist/`。也可以 `npm run pack` 生成未打包目录。

macOS 构建默认**未签名、未公证**；首次打开如果被 Gatekeeper 拦住，右键 → 打开，或：

```bash
xattr -dr com.apple.quarantine "/Applications/Busy Magpie.app"
```

当前 CI 在 `windows-latest` 上构建 Windows 安装包；macOS 的构建配置仍然保留，需要时在 [`.github/workflows/build.yml`](./.github/workflows/build.yml) 里重新启用 `macos-latest` 任务。

## 安装路径

Windows 安装包是 **per-user** 安装（`nsis.perMachine: false`），默认目录是：

```text
%LOCALAPPDATA%\Programs\Busy Magpie\Busy Magpie.exe
```

这是 Windows 桌面软件的常见做法：程序放 `LOCALAPPDATA\Programs`，不需要管理员权限，也不会把可执行文件放进漫游配置。安装时仍可以改到其他目录。

用户配置和日志放在 **Roaming AppData**，因为它属于用户数据，不是程序本体：

```text
%APPDATA%\Busy Magpie\settings.json
%APPDATA%\Busy Magpie\busy-magpie.log
```

**不建议**把 `.exe` 装进 `%APPDATA%`（Roaming）：域账号或开启漫游配置时，几十 MB 的 Electron 程序会被同步到每台机器，启动和登录都会变慢。也不建议默认装进 `%ProgramFiles%`，那需要 UAC 提权，升级也更麻烦。

启动器插件的查找顺序：

1. `BUSY_MAGPIE_APP`
2. `%LOCALAPPDATA%\Programs\Busy Magpie`
3. `%LOCALAPPDATA%\Programs\busy-magpie` / `BusyMagpie`
4. `%LOCALAPPDATA%\Busy Magpie`
5. `%PROGRAMFILES%\Busy Magpie` / `%PROGRAMFILES(X86)%`
6. macOS `/Applications/Busy Magpie.app`

如果安装到了自定义目录，设置 `BUSY_MAGPIE_APP` 即可；默认路径下不需要配置。

### 卸载插件时会发生什么

magpie 插件没有卸载生命周期钩子，所以**移除插件不会自动删除 Busy Magpie 桌面应用**。插件只是启动器；应用是单独安装的程序，卸载插件后它会继续留在：

```text
%LOCALAPPDATA%\Programs\Busy Magpie
```

要移除应用，使用 Windows「设置 → 应用」里的 Busy Magpie 卸载，或运行：

```text
%LOCALAPPDATA%\Programs\Busy Magpie\Uninstall Busy Magpie.exe
```

如果希望插件和桌面应用一起删，需要把应用改成插件目录内的便携版；当前版本没有这样做。

## 交互

### 移动

- **长按卡片顶部**（中间一排小圆点）约 0.4 秒，光标变成抓手后拖动；松手恢复点击穿透。
- 或者托盘菜单 →「调整位置…」，整张卡片进入调整模式，按 Esc 完成。

### 调整大小

- 鼠标移到卡片**任意一条边框或四个角**，出现对应方向的缩放光标后直接拖动。
- 上边/左边拖动时会同时移动窗口，保持对面的边不动。
- 最小 `600×432`，最大不超过当前屏幕可用区域。
- 尺寸会写入 `settings.json`，下次启动保持。

### 点击穿透

正常状态只有两个很小的区域会在鼠标悬停时临时接收指针：

- 顶部约 28px 的移动条
- 边框/四角约 8px 的缩放带

其余区域始终穿透，点击会落到下面的窗口。

## 路由视图

### 单请求

```text
DeepSeek Harness  ┈┈┈┈  magpie  ┈┈┈┈  team
team/deepseek-v4-flash   127.0.0.1:3425   deepseek-v4-flash
                                        回答了这个请求
```

下方显示「最近一个请求是怎么路由的」三行说明，以及请求数、改道数、Agent 收到的错误数。

### 多请求

```text
DeepSeek Harness ┈┐
                  ├─→  magpie  ─→  team
Codex            ┈┘              OpenAI
```

- 所有进行中的请求同时展开。
- 每个 Agent 一条彩色虚线，收束到同一个 magpie。
- 账号列独立排序，不跟 Agent 行对齐，所以线路会交叉。
- Agent 越多，节点越紧凑；更多时隐藏模型、状态等次要信息，保证每个 Agent 仍在画面里。
- 小喜鹊沿着真实线路飞行，穿过 magpie，喙上带着该 Agent 颜色的小点；回答时再飞回来。

### 总 token

顶部 token 胶囊读取 magpie 的 `/v1/magpie/usage`，显示当前时间窗的 token。数字变化时逐位向上滚动（可在设置里关掉，改成直接替换），下面的细条是缓存命中率。单请求的账号卡片还会显示这一条请求的「输出 324 · 缓存 98% · 首字 2.9s」明细。

**单击胶囊切换时间窗**：在设置里勾选的那几个窗口之间循环（默认 今日 → 近 7 天 → 近 30 天 → 全部），选择写进 `settings.json`，重启后保持。胶囊是卡片里唯一吃鼠标点击的控件——卡片其余部分仍然点击穿透，鼠标悬到胶囊上时主进程才把指针放进来。

胶囊显示的数值可以在设置里切换：总 token（输入 + 输出 + 缓存读/写）、输入、输出、缓存读。

### 额度与耗时

账号卡片底部会显示这个账号的剩余额度，比如「额度 13% · 6 天后续」，低于 15% 时变琥珀色；额度来自 trace 里账号的 `known` / `used` / `renews`，没有订阅额度的 Key 不显示。悬停整张账号卡片能看到完整明细：剩余百分比、credits 用量、续期时间。

请求耗时写在 token 明细行末尾（首字延迟），悬停卡片能看到「首字 / 总耗时 / 排队 / magpie 自身」的拆解。两项都可以在设置里关掉。

## 设置

托盘菜单 →「设置…」会把设置**铺在卡片上**：不另开窗口，也不改变窗口大小，关掉就原样回到卡片。进出的淡入淡出和卡片本身用的是同一块画布，所以缩放窗口时设置的字号也跟着变。

可以修改：

- 总在最前 / 隐藏账号名称 / 不透明度
- 时间窗（多选：勾选的才会在单击胶囊时循环）、胶囊数值、数字滚动
- 额度条、耗时拆解（首字延迟、输出 tok/s）、启动时检查更新
- 网关地址（留空自动检测）

右上角「打开文件夹」直达 `settings.json` 所在目录；保存后立即应用并写回文件。

拖卡片边框可以改窗口大小：卡片内容画在一块 600×400 的画布上，窗口会保持这个比例（拖宽拖高都按比例走），内容整体等比缩放——文字、节点、线路、胶囊一起变大变小，不会留下空白。

### settings.json

```json
{
  "topmost": true,
  "maskAccounts": true,
  "opacity": 1,
  "left": 1900,
  "top": 700,
  "width": 632,
  "height": 432,
  "gateway": null,
  "usagePeriod": "30d",
  "enabledPeriods": ["today", "7d", "30d", "all"],
  "pillMetric": "total",
  "rollTokens": true,
  "showQuota": true,
  "showTiming": true
}
```

| 字段 | 含义 |
| --- | --- |
| `topmost` | 是否永远盖在其他窗口上方 |
| `maskAccounts` | 是否隐藏邮箱 / Key |
| `opacity` | 不透明度，`0.4` – `1` |
| `left` / `top` | 窗口位置 |
| `width` / `height` | 窗口尺寸 |
| `gateway` | 固定网关；`null` 表示自动检测 |
| `usagePeriod` | token 胶囊当前的时间窗：`today` / `7d` / `30d` / `all` |
| `enabledPeriods` | 单击胶囊时循环哪几个窗口；至少一个，选中的才参与滚动 |
| `pillMetric` | 胶囊数值：`total` / `input` / `output` / `cache` |
| `rollTokens` | 数字是否逐位滚动；`false` 直接替换 |
| `showQuota` | 账号卡片里是否显示额度条 |
| `showTiming` | 是否把首字延迟写进请求明细 |

配置文件位置：

- Windows：`%APPDATA%\Busy Magpie\settings.json`
- macOS：`~/Library/Application Support/Busy Magpie/settings.json`

## magpie 重启了

卡片会自己接回去，不用点托盘里的「重新连接」：

- 读 trace 的长轮询失败后按 1 秒、2 秒、4 秒、5 秒退避重试，卡片右上角显示「重连中」；magpie 回来后几秒内自动恢复「实时」。
- 重启后的 magpie 是另一个进程（`pid` 变了），卡片会丢掉上一个进程留下的路由，重新取一份完整快照，不会把旧请求留在屏幕上。
- magpie 换了端口也能跟上：每次重试都会重新解析网关地址。
- 万一读 trace 的循环自己卡死或退出，每 15 秒一次的看门狗在 60 秒没有心跳时把它重建。

这条默认开着，没有开关，也不需要设置。

## 窗口不见了

两种情况，入口不同。

**只是隐藏了**（托盘里的「隐藏桌面插件」，或者不小心点掉了）：

- 按 `Ctrl+Alt+M`，全局快捷键，任何窗口在前面都能把卡片叫出来、再按一次收起；
- 或者点一下托盘图标（Windows），双击也切换显示。

快捷键在托盘菜单里可以关，组合键写在 `settings.json` 的 `hotkey`（默认 `Control+Alt+M`）。

**进程退出了**（托盘的「退出」、崩溃、装更新）：快捷键跟着进程一起没了，只能从外面重新启动：

- 桌面或开始菜单里的「Busy Magpie」——安装包会创建这两个快捷方式；
- 在 magpie 里把 busy-magpie 插件**关掉再打开**（或改一次「选项」保存），插件重载会重新拉起桌面卡片；
- 下一次经过网关的请求也会把它拉起来——桌面卡片每 10 秒写一个心跳，插件看到它停了就重新启动；设置里的「保活」可以关掉这条；
- 托盘菜单打开「开机自动启动」（需要安装版），登录进系统后它自己回来。

## 更新

应用和启动器插件分开更新：

- **桌面应用**：点卡片右上角的版本号，打开「关于 Busy Magpie」的同时立刻查一次更新（面板里也会显示「正在检查更新…」），可以检查更新、直接更新，或跳过某个版本。应用启动 2.5 秒后查一次，之后运行期间每小时查一次。
- **一键更新**：有新版时，那个位置直接变成「更新 vX」按钮——点一下就走完下载、校验、退出、静默安装、重启，不用先打开「关于」；更新期间它显示下载进度。这时版本号暂时让位，「关于」可以从托盘菜单打开。
- **启动器插件**：由 magpie 管理。到 magpie → Plugins → Busy Magpie 点 Update；不要在应用里直接覆盖插件文件。
- **更新方式**：设置里的「更新」三选一——
  - **空闲**（默认）：发现新版先记着，等你 5 分钟没有请求经过网关，插件自己退出卡片、静默安装、重新拉起；你正在用的时候不会被打断；
  - **提示**：只弹一次通知，更新留给你在「关于」里点；
  - **不检查**：连版本都不查。
- **版本不一致没关系**：应用版本读取自 `%APPDATA%\Busy Magpie\version`，插件版本由 magpie 插件目录决定，两者可以不同。

## 网关地址

按以下顺序解析：

1. `BUSY_MAGPIE_GATEWAY` 环境变量
2. `MAGPIE_ADDR` 环境变量
3. `~/.config/magpie/settings.json` 里的 `port`
4. `127.0.0.1:3425`

`MAGPIE_ADDR=0.0.0.0:3425` 这类监听地址会自动改连 `127.0.0.1:3425`。也可以在 `settings.json` 里固定：

```json
{
  "gateway": "http://127.0.0.1:3425"
}
```

## 它是怎么工作的

```text
magpie 本机网关 (:3425)
   │  GET /v1/magpie/trace   (long poll, 增量合并)
   │  GET /v1/magpie/usage   (总量)
   ▼
Electron 主进程
   │  IPC
   ▼
透明 BrowserWindow
   │
   ├─ 上方：单请求舞台 / 多 Agent 扇出
   ├─ 中部：总 token / 统计
   └─ 下方：最近请求说明
```

- trace 的 `after=seq` 返回的是**变化路由**，不是完整快照。主进程维护合并表，保证早开始、仍在执行的 Agent 不会从卡片消失。
- 渲染层没有 Node 权限，也不直接访问网络；所有请求都在主进程完成。
- 账号信息只在本地页面里展示；默认打码，不写日志。

## 开发

```bash
npm run dev                 # 打开开发者工具
npm start -- --layout       # 启动即进入调整位置模式
npm start -- --settings     # 启动即展开设置
```

开发实例和安装版共用 `%APPDATA%\Busy Magpie`，也就共用单实例锁：dev 那个开着的时候，安装版启动会静默退出（退出码 0、没有日志）。先关掉 dev 实例，再启动安装版。

本地模拟数据不需要真实请求：

```bash
# 单个请求
MOCK_COUNT=1 MOCK_START=1 python tools/mock_multi.py 3500
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start

# 四个并发 Agent
python tools/mock_multi.py 3500
BUSY_MAGPIE_GATEWAY=http://127.0.0.1:3500 npm start
```

`mock_multi.py` 也提供 `/v1/magpie/usage`，所以 token 胶囊在模拟环境里同样可用。

调试渲染层：

```bash
npx electron . --remote-debugging-port=9223
node tools/cdp.mjs eval "document.body.innerText"
node tools/cdp.mjs shot "artifacts/fan.png"
```

截图（2x）：

```bash
CDP_SCALE=2 node tools/cdp.mjs shot "docs/screenshots/multi.png"
```

## 项目结构

```text
src/main.js             窗口、托盘、长轮询、usage、拖动/缩放、设置面板
src/preload.js          contextBridge 白名单
web/index.html          卡片结构（含设置抽屉）
web/app.js              渲染、SVG 虚线、飞鸟、数字滚动、设置交互
web/presenter.js        只根据 trace 生成文案
web/styles.css          透明卡片、布局、动效
plugin/launch.hooks.mjs magpie 启动器插件（magpie.hooks 入口）
assets/                 magpie 鸟标、OpenAI / DeepSeek 图标、托盘/应用图标
tools/                  图标生成、模拟 trace、CDP 检查、Windows 打包
```

## 隐私

- 默认隐藏邮箱和 Key，只保留服务商名和模型名。
- 日志只记录连接失败、usage 失败和崩溃，不记录请求内容、账号或 Key。
- trace 和 usage 都只从本机 magpie 读取，不发送到外部。
- 项目不包含遥测。

## 已知限制

- 只展示本机 magpie 网关；远程 magpie 的 trace 由 magpie 自身限制为本机读取。
- 多请求时窗口尺寸不自动增长；并发很多时会隐藏次要信息，极小节点只保留 Agent / 账号名称。
- macOS 版本需要在 macOS 上构建；默认未签名、未公证。
- 不修改 magpie，因此不会在 magpie 的「路由」页里增加额外入口；入口是托盘图标。

## License

[MIT](./LICENSE)




