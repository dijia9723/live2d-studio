// Cubism Core 是全局脚本，所有舞台共享同一次加载。
const corePromises = new Map<string, Promise<void>>()

function loadCore(legacy: boolean) {
  const globalName = legacy ? 'Live2D' : 'Live2DCubismCore'
  if (Reflect.get(window, globalName)) return Promise.resolve()
  const pending = corePromises.get(globalName)
  if (pending) return pending
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = legacy ? '/api/v1/characters/cubism2-runtime' : '/lib/live2dcubismcore.min.js'
    const fail = () => {
      corePromises.delete(globalName)
      script.remove()
      reject(
        new Error(
          legacy
            ? '缺少可用的 Cubism 2 运行库。请将可信的 live2d.min.js 放入数据目录的 cubism2 子目录，再点重新加载。'
            : 'Cubism Core 加载失败，请检查本地运行库',
        ),
      )
    }
    script.onload = () => (Reflect.get(window, globalName) ? resolve() : fail())
    script.onerror = fail
    document.head.appendChild(script)
  })
  corePromises.set(globalName, promise)
  return promise
}

export async function loadLive2DRuntime(path: string) {
  const legacy = /(?:\/model|\.model)\.json$/i.test(path)
  await loadCore(legacy)
  const { Live2DModel } = legacy
    ? await import('pixi-live2d-display/cubism2')
    : await import('pixi-live2d-display/cubism4')
  return { legacy, Live2DModel }
}
