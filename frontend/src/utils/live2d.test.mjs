/**
 * 文件职责：Live2D 工具函数单元测试。
 * 覆盖参数命名兼容、情绪值钳制、动作/表情解析与口型参数选择。
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chooseMotion,
  createParameterBindings,
  lipSyncParameters,
  modelCapabilities,
  moodParameters,
} from './live2d.ts'

// 场景：Cubism 2 转换模型（PARAM_* 命名）与 Cubism 4 模型（Param* 命名）应得到相同的情绪参数。
test('converted PARAM_* models receive the same mood parameters as Param* models', () => {
  const modern = createParameterBindings(['ParamMouthForm', 'ParamEyeLOpen'], [-1, 0], [1, 1])
  const legacy = createParameterBindings(['PARAM_MOUTH_FORM', 'PARAM_EYE_L_OPEN'], [-1, 0], [1, 1])
  assert.deepEqual(moodParameters('happy', legacy), moodParameters('happy', modern))
  assert.equal(moodParameters('happy', legacy).find((p) => p.index === 0)?.value, 1)
  assert.equal(moodParameters('sad', legacy).find((p) => p.index === 0)?.value, -1)
  assert.deepEqual(moodParameters('neutral', legacy), [])
})

// 场景：情绪预设值应钳制到模型实际范围，且不写入模型不存在的参数。
test('presets clamp to actual model ranges and never write nonexistent parameters', () => {
  const bindings = createParameterBindings(['PARAM_EYE_L_OPEN', 'ParamMouthDown'], [0, 0], [1, 0.5])
  assert.deepEqual(moodParameters('surprised', bindings), [
    { index: 0, value: 1 },
    { index: 1, value: 0 },
  ])
  assert.equal(moodParameters('sad', bindings).find((p) => p.index === 1)?.value, 0.5)
  assert.deepEqual(moodParameters('unknown', bindings), [])
})

// 场景：从 Shizuku 的 model3.json 读取动作，随机反应动作需排除 Idle。
test('Shizuku actions are read from its manifest; random reactions exclude Idle', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../../../server/internal/modules/character/assets/shizuku/runtime/shizuku.model3.json', import.meta.url),
    ),
  )
  const caps = modelCapabilities(
    manifest.FileReferences.Expressions,
    manifest.FileReferences.Motions,
    new Map(),
  )
  assert.equal(caps.ready, true)
  assert.deepEqual(caps.expressions, [])
  assert.deepEqual(
    caps.motions.map((m) => m.group),
    ['FlickUp', 'Tap', 'Flick3', 'Idle'],
  )
  assert.equal(chooseMotion(caps.motions, undefined, () => 0).group, 'FlickUp')
  assert.equal(chooseMotion(caps.motions, undefined, () => 0.999).group, 'Flick3')
  assert.equal(chooseMotion(caps.motions, JSON.stringify(['Tap', 0])).group, 'Tap')
  assert.equal(chooseMotion(caps.motions, JSON.stringify(['', 0])), undefined)
})

// 场景：Mao 模型保留具名原生表情，并支持动作组名为空的合法动作。
test('Mao retains named native expressions and valid empty-group motions', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../../../server/internal/modules/character/assets/mao_pro/runtime/mao_pro.model3.json', import.meta.url),
    ),
  )
  const caps = modelCapabilities(
    manifest.FileReferences.Expressions,
    manifest.FileReferences.Motions,
    new Map(),
  )
  assert.deepEqual(
    caps.expressions.map((e) => e.id),
    ['exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05', 'exp_06', 'exp_07', 'exp_08'],
  )
  assert.equal(caps.motions.length, 7)
  assert.equal(chooseMotion(caps.motions, undefined, () => 0).group, '')
  assert.equal(chooseMotion(caps.motions, JSON.stringify(['', 5])).index, 5)
  assert.equal(chooseMotion([], undefined), undefined)
})

// 场景：口型同步优先使用模型声明的参数 ID，并兼容旧命名且不虚构参数。
test('lip sync prefers model-defined IDs and supports legacy IDs without inventing parameters', () => {
  const bindings = createParameterBindings(['PARAM_MOUTH_OPEN_Y', 'ParamA'], [0, 0], [1, 2])
  assert.deepEqual(
    lipSyncParameters(bindings, ['PARAM_MOUTH_OPEN_Y']).map((p) => p.index),
    [0],
  )
  assert.deepEqual(
    lipSyncParameters(bindings).map((p) => p.index),
    [0, 1],
  )
  assert.deepEqual(lipSyncParameters(bindings, ['Nonexistent']), [])
})
