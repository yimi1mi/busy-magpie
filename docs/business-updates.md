# 业务包更新

1.4.0 的 Windows 和 macOS 应用由稳定壳和本地业务目录组成。安装目录保留 Electron、依赖、`shell/`、插件和内置业务版本；业务更新写入用户配置目录下的 `business-updates/versions/`。已加载的文件不会被覆盖。

## 代码归属

| 内容 | 更新方式 |
| --- | --- |
| `src/`、`web/`、`assets/` | 签名业务包，受壳接口版本约束 |
| `shell/`、Electron、`node_modules/`、原生窗口模块 | 完整安装包 |
| `plugin/` | magpie 插件更新 |
| 用户的 `settings.json`、日志和心跳 | 用户数据，独立于版本目录 |

`package.json` 的入口是 `shell/bootstrap.cjs`。它先获取单实例锁，再验证并加载业务版本。业务主进程通过 `globalThis.__busyShell` 获得业务版本、壳版本、更新器和原生背景能力。业务包没有自己的 `node_modules`；新增依赖或改变壳接口时必须发布新壳，并相应提高 `minShellVersion` 或 `shellApi`。

业务包是受信任的主进程代码，拥有应用权限。签名用来确认发布者与内容，没有把这些代码变成沙箱插件。运行时只加载已经下载、验证并写入本地目录的文件。

## 一次更新

1. 检查业务清单和完整安装包两个渠道，优先处理新版运行环境。
2. 下载 `.bmpkg`，检查长度和传输 SHA-256，再验证 Ed25519 签名、逐文件哈希、路径、必需入口和壳兼容性。
3. 写入临时目录，再重命名为不可变版本目录。此时当前业务不变。
4. 用户点击更新，或满足空闲条件后，创建待确认记录并备份设置。启动独立监督进程，收到它的接管确认后，应用才请求退出。
5. 监督进程等待旧业务停止，再启动候选版本。停止判据为操作系统确认进程退出（Windows 使用进程句柄），或稳定壳的退出握手：Node 已发出退出事件、所有窗口已关闭、单实例锁已释放，且令牌、PID、时间均匹配本次交接。最多等待 30 秒，超时取消，不强杀旧进程。
6. 候选版必须在 60 秒内完成窗口、文档和 bootstrap IPC 检查，并持续存活和报告健康状态至少 3 秒。网关离线是正常状态，不作为更新失败条件。
7. 确认成功后，原子更新 `journal.json` 的当前和上一版本。候选退出、启动失败或超时，则先确认候选业务已经停止，保留它产生的失败配置，恢复备份，再启动上一可用版本。没有合法退出握手时，必须等待候选进程真实退出，必要时只终止监督进程自己启动的候选。旧版也必须报告窗口就绪；不会循环重启。

Electron 的业务退出与原生进程完全结束可能相隔较长时间。业务包使用独立文件目录，也不覆盖 exe，因此退出握手后可以启动新版，同时让旧进程继续完成原生清理。日志分别记录 `quiescent` 和进程 `exit`，不将两者混为一谈。壳接口 1 要求所有业务持久化在 Node 退出前完成，不能在 `app.quit` 监听中继续写设置；当前设置写入均为同步写入及重命名。新增异步持久化或退出监听时必须重新验证这一接口约束。

新版启动失败后，该业务版本会被隔离，等待更高版本。未完成的启动事务在下次启动时恢复设置；损坏的日志状态会保留原始副本并回到安装内置版本。旧版本目录和事务证据暂不自动清理。

自动更新仍遵循原有策略：空闲模式先下载，连续五分钟无请求、无活动请求、无打开的操作面板时重启；提示模式等待用户操作；不检查模式仅禁用自动检查。

## 格式和签名

`.bmpkg` 是有大小上限的 gzip JSON，包含 `manifest`、`signature` 和按相对路径编码的文件。签名覆盖规范化的整个 manifest，包括版本、最低壳版本、接口版本和全部文件哈希。压缩体积上限 32 MiB，解压 JSON 上限 64 MiB，文件数上限 512。

壳信任的公钥在 `shell/trusted-keys.json`。私钥不能放进业务源码、安装包或 Git。当前开发机的私钥保存在被 Git 忽略的 `artifacts/signing/business-ed25519.pem`；应另外备份到受控存储，CI 使用机密变量。丢失私钥后，需要通过完整安装包分发新公钥；不能用随业务包下载的公钥自行建立信任。

一次性的密钥生成命令如下。已有项目不要重新运行来覆盖当前公钥；工具会拒绝覆盖已有文件。

```powershell
node tools/create-signing-key.cjs artifacts/signing/business-ed25519.pem busy-magpie-2026 shell/trusted-keys.json
```

构建业务包：

```powershell
npm run dist:business -- --output dist/business-1.4.1 --key-file artifacts/signing/business-ed25519.pem --key-id busy-magpie-2026 --version 1.4.1 --min-shell-version 1.4.0 --base-url https://github.com/yimi1mi/busy-magpie/releases/download/business-stable/
```

输出 `1.4.1.bmpkg` 和 `business-latest.json`。清单内的下载哈希只负责传输完整性，包内签名才是信任依据。修复失败版本时使用更高版本号，不覆盖同版本包。

## 发布渠道

- 完整安装包仍使用普通版本 Release、`latest.yml` 和 Windows 安装器，兼容 1.3.x 及旧启动器。
- 业务包使用单独的 `business-stable` 标签及 `business-latest.json`。这个 Release 必须标为 **pre-release**，且 **不能设为 latest**，以免旧启动器把它当成安装器版本。安装包与业务包不能共用 `latest.yml`。
- 发布顺序为先上传新的版本包，再替换业务清单；旧包保留。先在隔离 profile 验证升级和回退，再更新此渠道。
- 构建命令只生成本地产物，不创建标签、不上传文件、不发布 Release。第一次迁入 1.4.0 仍需完整安装；以后修改 Electron、原生依赖或壳接口也需要完整安装。

完整安装包可通过 `build` Action 的 `release_mode` 发布：`build` 只构建和校验，`prerelease` 自动上传后公开为预发布，`release` 自动上传后公开为正式 Latest。Windows 和 macOS 的构建、真实更新测试均成功后，Action 在 GitHub 内汇总两平台清单并发布，不需要经过本机搬运。发布前核对标签提交，发布后核对每个附件的服务器 SHA256；上传或校验失败时不公开半成品，也不覆盖内容不同的已有正式版本。

这条 Action 发布的是完整安装包，不能代替需要独立签名私钥的 `business-stable` 业务包发布流程。

默认业务地址在 `shell/config.json`。普通安装版只接受 HTTPS，逐跳检查重定向。开发实例或 `--preview` 可以显式设置 `BUSY_MAGPIE_DEV_UPDATE_FEED`，允许本机 HTTP 夹具；普通预览默认不检查或安装更新，也不改正式用户配置和登录启动项。

## 验证与诊断

```powershell
npm test
node tests/business-update-e2e.cjs
```

前者覆盖签名、不可变目录、事务和真实子进程监督；后者使用真实 Electron、主进程、preload、页面和本地签名源，验证成功切换与失败回退。端到端测试使用临时密钥和独立 profile，不安装或替换正式版本。

构建 Windows 产物后，还可直接验证原始打包程序：

```powershell
$unpacked = (Resolve-Path dist/local-1.4.0-shell/win-unpacked).Path
node tests/business-update-e2e.cjs --original-immutable $unpacked
```

此模式保留产物的入口、公钥和全部文件，使用独立 profile 及本机调试接口驱动真实更新；测试包用本机已有签名私钥生成，只保存在忽略目录，不能发布。测试会核对运行依赖来自打包目录，以及升级和回退前后原产物文件完全一致。

诊断文件在 `%APPDATA%\Busy Magpie\business-updates\`：`update.log` 记录接管、PID、退出与回退阶段；`journal.json` 记录版本状态；`transactions/<token>/` 保留设置备份和失败配置。启动器用的 `updating` 标记仍在用户配置目录，避免交接期间把应用提前拉起。

macOS CI 在真实打包应用的隔离副本上执行相同的业务更新、回退和重启保持测试。业务包不改写 `.app`，可以使用这条签名更新链路；macOS 运行环境的完整升级仍需手动安装。构建未提供 Developer ID 签名和公证，系统首次安装检查需另外处理。
