const { copyFile, readdir, rm, stat } = require('node:fs/promises')
const path = require('node:path')

const KEEP_LOCALES = new Set(['en-US.pak', 'zh-CN.pak'])
async function pruneLocales(appOutDir) {
  const localesDir = path.join(appOutDir, 'locales')

  let entries = []
  try {
    entries = await readdir(localesDir, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    return { removed: 0 }
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.pak') || KEEP_LOCALES.has(entry.name)) {
      continue
    }

    await rm(path.join(localesDir, entry.name), { force: true })
    removed += 1
  }

  return { removed }
}

// onnxruntime.dll 依赖 VC++ 2022 运行库（含 MSVCP140_ATOMIC_WAIT.dll，老版本运行库没有）。
// 没装或版本太旧的电脑会加载失败、海克斯识别整个不可用，所以按微软允许的 app-local 方式
// 把运行库 DLL 放到 onnxruntime.dll 旁边，Windows 加载依赖时会优先用同目录的。
const VC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
]

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function bundleVcRuntime(appOutDir) {
  const targetDir = path.join(
    appOutDir, 'resources', 'app.asar.unpacked', 'node_modules',
    'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64'
  )
  if (!(await exists(path.join(targetDir, 'onnxruntime.dll')))) {
    throw new Error(`[afterPack] onnxruntime.dll not found in ${targetDir}`)
  }
  const systemDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const copied = []
  for (const name of VC_RUNTIME_DLLS) {
    const source = path.join(systemDir, name)
    if (!(await exists(source))) {
      throw new Error(`[afterPack] VC++ runtime ${name} not found in ${systemDir}; install the latest VC++ 2015-2022 x64 redistributable on the build machine`)
    }
    await copyFile(source, path.join(targetDir, name))
    copied.push(name)
  }
  return copied
}

module.exports = async function afterPack(context) {
  const localeResult = await pruneLocales(context.appOutDir)
  if (context.electronPlatformName === 'win32') {
    const copied = await bundleVcRuntime(context.appOutDir)
    console.log(`[afterPack] bundled VC++ runtime next to onnxruntime.dll: ${copied.join(', ')}`)
  }

  console.log(
    `[afterPack] removed ${localeResult.removed} Electron locale files; ` +
      'kept Electron runtime ffmpeg.dll; left app.asar.unpacked intact for Electron ASAR integrity'
  )
}
