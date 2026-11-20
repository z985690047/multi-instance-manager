/**
 * 平台判断的唯一出口：主进程内不要散落 process.platform 比较
 */
export const PLATFORM = process.platform
export const IS_MAC = PLATFORM === 'darwin'
export const IS_WIN = PLATFORM === 'win32'
export const IS_LINUX = PLATFORM === 'linux'
