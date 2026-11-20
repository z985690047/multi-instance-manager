const { execSync } = require('child_process')
const path = require('path')

// 本地 ad-hoc 签名：解决无证书打包后 macOS Gatekeeper 提示「已损坏」的问题
// 注意：ad-hoc 签名无法通过公证，分发时仍可能触发「无法验证开发者」提示
module.exports = {
  appId: 'com.doubao.multi-manager',
  // 打包后的应用名（.app 名称、菜单栏、Dock、关于面板）
  productName: '豆包多开管理器',
  mac: {
    icon: 'build/icon.icns',
    artifactName: 'doubao-multi-manager-${version}-${arch}.${ext}',
    // 跳过 electron-builder 自带的证书签名流程，改由 afterPack 钩子做 ad-hoc 签名
    identity: null,
  },
  win: {
    icon: 'build/icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'doubao-multi-manager-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '豆包多开管理器',
    // 卸载时保留账号与登录态数据
    deleteAppDataOnUninstall: false,
  },
  afterPack: async (context) => {
    // 仅 macOS 做 ad-hoc 签名；Windows/Linux 没有 codesign
    if (context.electronPlatformName !== 'darwin') return
    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    )
    console.log(`  • ad-hoc signing ${appPath}`)
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: 'inherit',
    })
  },
}
