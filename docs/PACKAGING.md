# 打包注意事项（macOS / Windows）

本文按「照着做就能打出包」的顺序组织，所有条目均来自本项目实际踩过的问题。

---

## 1. 打包前检查

1. 确认版本号：`package.json` 的 `version` 决定产物文件名与关于面板版本。
2. 确认主进程能构建：`npm run build` 无报错（会产出 `out/main`、`out/preload`、`out/renderer`）。
3. 确认图标资源存在且有效：
   - `build/icon.icns`（macOS）
   - `build/icon.ico`（Windows，内含 16/32/48/64/128/256 六档 PNG）
   - `build/icon.png`（1024×1024，开发模式 Dock 图标）
   - `build/icon.svg`（设计源文件，改图标只改它再重新导出）
4. 关闭正在运行的开发实例（`npm run dev`）。打包应用与开发实例共用同一个 userData 和单实例锁，同时运行会导致新实例直接退出，干扰验证。

---

## 2. Electron 二进制下载失败（最常见）

### 症状

日志停在：

```
• downloading url=https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-darwin-arm64.zip size=100 MB parts=8
• retrying attempt=1
```

`dist/mac-arm64` 长时间为空，进程不退出。

### 原因与处理

1. **网络无法直连 GitHub**。改用国内镜像：

   ```bash
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:mac
   ```

   若镜像目录结构与官方不同，再补 `ELECTRON_CUSTOM_DIR`：

   ```bash
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
   ELECTRON_CUSTOM_DIR={{ version }} \
   npm run dist:mac
   ```

2. **缓存损坏导致无限重试**。本项目实际遇到过：分片下载被中断后合并出的缓存是 199MB（正常约 100MB），`unzip` 校验失败，后续每次打包都重新下载再失败。

   缓存位置：
   - macOS：`~/Library/Caches/electron/`
   - Windows：`%LOCALAPPDATA%\electron\Cache\`

   处理步骤：

   ```bash
   # 1) 先停掉残留构建进程，别让它继续写缓存
   pkill -f "electron-builder|app-builder|dist:mac"

   # 2) 校验缓存
   unzip -t ~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip

   # 3) 校验失败就删掉（只删目标版本，别清空整个目录）
   rm -f ~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip

   # 4) 用镜像重打
   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist:mac
   ```

   判断依据：文件体积明显大于日志里的 `size=100 MB`，或 `unzip -t` 报错，即为损坏。**不要在缓存损坏的情况下反复空跑**。

3. Windows 上构建时还可能需要 `ELECTRON_BUILDER_BINARIES_MIRROR`（NSIS 等工具），视网络情况设置：

   ```bash
   ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
   ```

---

## 3. 应用名与 userData（改中文名必看）

`electron-builder.config.js` 里：

```js
productName: '豆包多开管理器'
```

`productName` 会同时决定 `.app`/`.exe` 名称、macOS 菜单栏与 Dock 名称、关于面板名称，**也会改变 Electron 默认的 userData 目录名**（变成 `…/豆包多开管理器`）。一旦生效，已有账号、登录态、产物缓存会「消失」（实际是换了目录）。

因此主进程入口在 `app ready` 之前显式固定：

```ts
app.setName('豆包多开管理器')
app.setPath('userData', join(app.getPath('appData'), 'doubao-multi-manager'))
```

- macOS 实际目录：`~/Library/Application Support/doubao-multi-manager`
- Windows 实际目录：`%APPDATA%\doubao-multi-manager`
- `persist:doubao_<id>` 登录分区位于 `<userData>/Partitions/`，随 userData 一起保留

**打包后必须验证**（见第 9 节）：目录里仍是 `accounts.json`、`Partitions/`、`artifacts-debug.log`、`attach-debug.log`，且没有出现中文名的新目录。

---

## 4. 图标

### 资源与生成

| 文件 | 用途 |
|---|---|
| `build/icon.svg` | 设计源文件（1024×1024 画布，圆角方形底 + 三层错位窗口） |
| `build/icon.png` | 1024×1024 透明 PNG，开发模式 Dock 图标 |
| `build/icon.icns` | macOS 打包图标，含 16/32/128/256/512 及 @2x |
| `build/icon.ico` | Windows 打包图标，含 16/32/48/64/128/256 |

修改图标流程：

1. 改 `build/icon.svg`；
2. 把 SVG 渲染为 1024×1024 PNG。本项目使用 Electron 的离屏窗口截取（`transparent: true` + `webContents.capturePage()`，注意 Retina 下会得到 2048，需再缩回 1024），也可用任意 SVG 栅格化工具；
   ```bash
   sips -z 1024 1024 /path/to/rendered.png --out build/icon.png
   ```

3. 重建 icns：

   ```bash
   mkdir -p /tmp/icon.iconset
   for s in 16 32 128 256 512; do
     sips -z $s $s build/icon.png --out /tmp/icon.iconset/icon_${s}x${s}.png
     sips -z $((s*2)) $((s*2)) build/icon.png --out /tmp/icon.iconset/icon_${s}x${s}@2x.png
   done
   iconutil -c icns /tmp/icon.iconset -o build/icon.icns
   ```

4. 重建 ico（用多尺寸 PNG 打包成 ICO 容器，Node 脚本生成；也可用 ImageMagick）。

### 配置引用

```js
mac: { icon: 'build/icon.icns' },
win: { icon: 'build/icon.ico' },
```

### 开发模式

`app.dock.setIcon(build/icon.png)` 仅在 macOS 且未打包时调用（`src/main/index.ts` 的 `whenReady` 内）。**这是主进程代码，必须重启 `npm run dev` 才生效**，HMR 不会更新。Windows 开发模式没有对应 API，任务栏图标来自 Electron 自身。

---

## 5. 签名与公证

### 当前状态（ad-hoc）

`electron-builder.config.js`：

```js
mac: { identity: null },
afterPack: async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  execSync(`codesign --force --deep --sign - "${appPath}"`)
}
```

- `identity: null` 跳过 electron-builder 的证书流程；
- `afterPack` 做 ad-hoc 签名，**只解决「应用已损坏，无法打开」**；
- 仍然会提示「无法验证开发者」，且无法通过公证；
- 注意：`afterPack` 必须按平台提前 return，否则在 Windows 上会调用 `codesign` 直接失败（已处理）。

### 正式分发需要

- macOS：
  1. Apple Developer Program 账号；
  2. `Developer ID Application` 证书导入钥匙串；
  3. 去掉 `identity: null`，配置 `hardenedRuntime`、`entitlements`，并接入 `notarize`（Apple ID + app-specific password 或 API Key）；
  4. 公证通过后用户首次打开才不会被 Gatekeeper 拦截。
- Windows：
  1. 代码签名证书（OV/EV）；
  2. 在 `win` 段配置 `certificateFile` / `certificatePassword`（或使用云签名）；
  3. 未签名时安装包可运行，但会触发 SmartScreen「未知发布者」提示；EV 证书可较快建立信誉。

---

## 6. 跨平台差异（已在代码中处理）

| 主题 | 实现 |
|---|---|
| 平台判断 | `src/main/platform.ts` 统一导出 `IS_MAC / IS_WIN / IS_LINUX`，主进程不要再直接写 `process.platform === 'darwin'` |
| 窗口 | 两端都是无边框：macOS 用 `titleBarStyle: 'hiddenInset'` + 系统红绿灯；Windows 用渲染层 `.win-controls`（最小化/最大化/关闭），窗口可拖边缩放 |
| 托盘图标 | macOS 用 16×16 模板图（`setTemplateImage(true)`，跟随菜单栏明暗）；Windows/Linux 用 32×32 彩色图标（模板图仅在 macOS 生效，深色任务栏上黑色图标几乎不可见） |
| 托盘行为 | 两端左键切换窗口、右键菜单；关闭窗口 = 隐藏到托盘（`app.isQuitting` 控制真正退出） |
| 应用菜单 | 非 macOS 且已打包时 `Menu.setApplicationMenu(null)`，避免与自定义标题栏重复；开发模式保留默认菜单便于调试 |
| 快捷键 | 项目当前没有注册任何全局快捷键或 `accelerator`，因此不存在 Cmd/Ctrl 分支；后续新增需按平台区分 `CommandOrControl` |
| Linux | 托盘左键点击依赖桌面环境，部分发行版只响应菜单，属已知限制 |

---

## 7. 自定义协议 `artifactstream://`

用途：右侧产物面板的图片/视频预览与视频首帧封面。必须同时满足三处：

1. **app ready 之前注册特权**（`src/main/index.ts` 顶部）：

   ```ts
   protocol.registerSchemesAsPrivileged([
     { scheme: 'artifactstream', privileges: { standard: true, stream: true, supportFetchAPI: true } }
   ])
   ```

2. **ready 之后注册处理器**：`protocol.handle('artifactstream', ...)`，按 `item.id` 查产物、用对应 `persist:` session `fetch` 上游、透传 `Range` 与 `206/200`。
3. **渲染层 CSP 必须包含该协议**（`src/renderer/index.html`）：

   ```
   media-src 'self' artifactstream:
   img-src 'self' data: blob: artifactstream:
   ```

   CSP 缺失时的典型报错：`Refused to load media ... because it violates ... "media-src 'self' artifactstream:"`。**不要靠放宽到 `https:` 解决**。

打包后验证方式：启动应用的子进程参数里应出现 `--standard-schemes=artifactstream --fetch-schemes=artifactstream --streaming-schemes=artifactstream`。

---

## 8. 构建命令与产物

```bash
npm run build       # 仅构建 out/，用于本地排查
npm run dist:mac    # macOS：dmg + zip
npm run dist:win    # Windows：NSIS 安装包
```

macOS 产物（Apple Silicon）：

```
dist/doubao-multi-manager-0.1.0-arm64.dmg        # 约 94 MB
dist/doubao-multi-manager-0.1.0-arm64.dmg.blockmap
dist/doubao-multi-manager-0.1.0-arm64.zip        # 约 90 MB
dist/doubao-multi-manager-0.1.0-arm64.zip.blockmap
dist/mac-arm64/豆包多开管理器.app
```

Windows 产物（x64，NSIS）：

```
dist/doubao-multi-manager-0.1.0-x64.exe          # 安装包
dist/win-unpacked/豆包多开管理器.exe
```

NSIS 配置：非一键安装、允许改安装目录、创建桌面与开始菜单快捷方式（名称「豆包多开管理器」）、卸载时保留 `%APPDATA%\doubao-multi-manager`。

注意：`dist:win` 必须带 `--config electron-builder.config.js`（已在 `package.json` 中配好），否则读不到上面这些配置。

---

## 9. 打包后验证清单

按顺序执行，任何一项失败都不要直接分发。

1. **应用名**：`.app` 名称、Dock、菜单栏、关于面板均为「豆包多开管理器」。
   ```bash
   /usr/libexec/PlistBuddy -c "Print :CFBundleName" -c "Print :CFBundleDisplayName" \
     "dist/mac-arm64/豆包多开管理器.app/Contents/Info.plist"
   ```
2. **图标**：打包内图标与源文件一致。
   ```bash
   shasum build/icon.icns "dist/mac-arm64/豆包多开管理器.app/Contents/Resources/icon.icns"
   ```
3. **签名**：`codesign -dv --verbose=2 <app>` 显示 `Signature=adhoc`；`spctl -a -vv <app>` 在关闭 security 的本机可通过，但分发后仍可能提示未验证开发者。
4. **窗口**：启动后有窗口，标题为「豆包多开管理器」，可拖动、可缩放。
5. **userData**：进程参数包含 `--user-data-dir=/Users/<you>/Library/Application Support/doubao-multi-manager`；`accounts.json`、`Partitions/`、两个 debug 日志都在原目录；没有生成中文名目录。
6. **账号与登录态**：原有账号列表完整，打开账号后豆包页面无需重新登录（persist 分区生效）。
7. **产物面板**：历史对话能拉到生成图片/视频；用户上传的源文件不出现在面板；任务模式（rich_media）产物能出现。
8. **同步文件**：输入公网直链 → 自动切「新工作任务」→ 下载 → 注入输入框出现附件卡片；失败时提示原因且保留文件。
9. **视频播放与封面**：产物视频可预览、可拖动进度；无 `cover_url` 的视频首帧封面正常，H.265 原片应回退为文件名占位而不是空白块。
10. **托盘与关闭**：关闭窗口隐藏到托盘，托盘菜单可显示/隐藏、打开账号、退出。

---

## 10. 已知限制

- 未配置正式证书：macOS 无法公证，Windows 会触发 SmartScreen；仅适合内部使用。
- Windows 版本尚未实机验证：无边框窗口拖拽、自定义窗口按钮、托盘图标观感、NSIS 快捷方式、`artifactstream` 视频播放均需在 Windows 上跑一遍清单。
- Electron 二进制与 NSIS 工具依赖外网，首次构建建议直接使用国内镜像，缓存损坏时先清理再重试。
- `dist/` 会保留旧命名产物（artifactName 变更前生成的），分发前注意只取最新时间戳的文件。
- 打包时 `package.json` 缺少 `author` 字段会有警告，不影响构建。
- 单实例锁基于 userData：开发实例与打包应用不能同时运行，验证打包产物前先退出 `npm run dev`。
