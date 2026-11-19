import { BaseTexture, Renderer, Texture, Ticker, utils } from 'pixi.js'
import type { IRenderingContext } from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display'

interface Preview {
  model: Live2DModel
  render: (renderer: Renderer, delta: number) => void
  onError: (error: unknown) => void
}

// Cubism 的着色器在同一模块内共享。用一个 WebGL 画布渲染，再复制到各卡片的 2D 画布。
export function createCharacterPreviewRenderer() {
  const previews = new Set<Preview>()
  let renderer: Renderer | undefined
  let ticker: Ticker | undefined

  function attach(
    canvas: HTMLCanvasElement,
    model: Live2DModel,
    onFrame: () => void,
    onError: (error: unknown) => void,
  ) {
    const output = canvas.getContext('2d')
    if (!output) throw new Error('浏览器无法创建预览画布')
    const bounds = model.getLocalBounds()
    model.anchor.set(0.5, 0.5)

    if (!renderer) {
      const view = document.createElement('canvas')
      // Cubism 2 需要 WebGL 1，同一个画布也可以渲染 Cubism 4 模型。
      const context = view.getContext('webgl', { alpha: true, stencil: true, antialias: true })
      if (!context) throw new Error('角色预览需要 WebGL 支持')
      renderer = new Renderer({
        view,
        context: context as IRenderingContext,
        backgroundAlpha: 0,
        width: 1,
        height: 1,
      })
      const sharedRenderer = renderer
      const sharedTicker = new Ticker()
      sharedTicker.maxFPS = 30
      sharedTicker.add(() => {
        for (const preview of previews) {
          try {
            preview.render(sharedRenderer, sharedTicker.deltaMS)
          } catch (error) {
            preview.onError(error)
          }
        }
      })
      ticker = sharedTicker
      ticker.start()
    }

    let firstFrame = true
    const preview: Preview = {
      model,
      onError,
      render(sharedRenderer, delta) {
        const width = canvas.clientWidth
        const height = canvas.clientHeight
        if (!width || !height) return
        if (canvas.width !== width || canvas.height !== height || firstFrame) {
          canvas.width = width
          canvas.height = height
          model.scale.set(Math.min((width * 0.94) / bounds.width, (height * 0.97) / bounds.height))
          model.position.set(width / 2, height * 0.515)
        }
        // 相邻列有时相差一个像素。共享画布只扩容，避免在每帧中来回调整尺寸。
        if (sharedRenderer.width < width || sharedRenderer.height < height) {
          sharedRenderer.resize(
            Math.max(sharedRenderer.width, width),
            Math.max(sharedRenderer.height, height),
          )
        }
        model.update(delta)
        sharedRenderer.render(model)
        output.clearRect(0, 0, width, height)
        output.drawImage(sharedRenderer.view, 0, 0, width, height, 0, 0, width, height)
        if (firstFrame) {
          firstFrame = false
          onFrame()
        }
      },
    }
    previews.add(preview)
    return () => {
      previews.delete(preview)
      release(model)
      if (!previews.size) {
        ticker?.destroy()
        renderer?.destroy(true)
        ticker = undefined
        renderer = undefined
      }
    }
  }

  function release(model: Live2DModel) {
    // 清除闲置纹理的缓存引用。进行中的模型加载仍可使用自己持有的纹理对象。
    const activeTextures = [...previews].flatMap((preview) => preview.model.textures)
    for (const texture of model.textures) {
      if (!activeTextures.includes(texture)) Texture.removeFromCache(texture)
      const base = texture.baseTexture
      if (!activeTextures.some((active) => active.baseTexture === base)) {
        for (const key of [...base.textureCacheIds]) {
          if (utils.BaseTextureCache[key] === base) BaseTexture.removeFromCache(key)
        }
        renderer?.texture.destroyTexture(base)
      }
    }
    model.destroy({ children: true, texture: false, baseTexture: false })
  }

  return { attach, release }
}

export type CharacterPreviewRenderer = ReturnType<typeof createCharacterPreviewRenderer>
