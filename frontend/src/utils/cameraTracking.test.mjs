import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bodyTrackingValues,
  createCameraParameterDriver,
  createCameraSampleBuffer,
  currentCameraSample,
  faceTrackingValues,
} from './cameraTracking.ts'
import { createParameterBindings } from './live2d.ts'

const noFace = { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }

test('face tracking mirrors yaw, gaze and asymmetric blinks', () => {
  const sine = Math.sin(Math.PI / 9)
  const cosine = Math.cos(Math.PI / 9)
  const values = faceTrackingValues({
    ...noFace,
    facialTransformationMatrixes: [
      {
        rows: 4,
        columns: 4,
        data: [cosine, 0, -sine, 0, 0, 1, 0, 0, sine, 0, cosine, 0, 2, 3, 4, 1],
      },
    ],
    faceBlendshapes: [
      {
        categories: [
          { categoryName: 'eyeBlinkRight', score: 0.9 },
          { categoryName: 'eyeLookOutLeft', score: 0.5 },
          { categoryName: 'jawOpen', score: 0.6 },
        ],
      },
    ],
  })
  assert.ok(Math.abs(values.anglex + 20) < 1e-8)
  assert.equal(values.eyelopen, 0)
  assert.equal(values.eyeropen, 1)
  assert.equal(values.eyeballx, -0.5)
  assert.ok(values.mouthopen > 0.9 && values.mouthopen <= 1)
  assert.deepEqual(faceTrackingValues(noFace), {})
})

test('body tracking uses visible shoulders and does not mix different people', () => {
  const point = (x, y, z, visibility = 1) => ({ x, y, z, visibility })
  const torso = []
  torso[11] = point(0.2, 0.03, 0.08)
  torso[12] = point(-0.2, 0, 0)
  torso[23] = point(0.2, 0.4, 0.15)
  torso[24] = point(-0.2, 0.4, 0.15)
  const pose = { landmarks: [[point(0.5, 0.4, 0)]], worldLandmarks: [torso] }
  const face = { ...noFace, faceLandmarks: [[undefined, point(0.5, 0.4, 0)]] }
  const values = bodyTrackingValues(pose, face)
  assert.ok(values.bodyx < 0)
  assert.ok(values.bodyy < 0)
  assert.ok(values.bodyz > 0)
  const otherPerson = { ...noFace, faceLandmarks: [[undefined, point(0.1, 0.4, 0)]] }
  assert.deepEqual(bodyTrackingValues(pose, otherPerson), {})
  torso[23].visibility = 0.3
  assert.equal(bodyTrackingValues(pose, face).bodyy, undefined)
  torso[12].visibility = 0.3
  assert.deepEqual(bodyTrackingValues(pose, face), {})
})

test('camera driver supports legacy IDs, clamps to model bounds and fades missing channels', () => {
  const bindings = createParameterBindings(['PARAM_BODY_X', 'ParamEyeLOpen'], [-5, 0], [5, 1])
  const drive = createCameraParameterDriver(bindings)
  const frame = (values) => {
    const writes = []
    drive(values, 70, (index, value, weight) => writes.push({ index, value, weight }))
    return writes
  }
  const initial = frame({ bodyx: 10, eyelopen: 0, mouthopen: 1 })
  assert.deepEqual(
    initial.map(({ index, value }) => [index, value]),
    [
      [1, 0],
      [0, 5],
    ],
  )
  const next = frame({ bodyx: -10 })
  assert.ok(next[0].weight < initial[0].weight)
  assert.ok(next[1].weight > initial[1].weight)
  assert.ok(next[1].value > -5 && next[1].value < 5)
  for (let frameCount = 0; frameCount < 5; frameCount++) frame(null)
  assert.deepEqual(frame(null), [])
})

test('stale samples do not keep overriding manual stage controls', () => {
  const sample = { time: 100, values: { anglez: 12 } }
  assert.equal(currentCameraSample(sample, 449), sample.values)
  assert.equal(currentCameraSample(sample, 450), null)
  assert.equal(currentCameraSample(null, 150), null)
})

test('short dropouts are held without extending stale channels when another detector updates', () => {
  const retain = createCameraSampleBuffer()
  assert.deepEqual(retain(0, { anglex: 8 })?.values, { anglex: 8 })
  assert.deepEqual(retain(125, { bodyx: -2 })?.values, { anglex: 8, bodyx: -2 })
  assert.deepEqual(retain(180, {})?.values, { anglex: 8, bodyx: -2 })
  assert.deepEqual(retain(220, { anglex: Number.NaN })?.values, { bodyx: -2 })
  assert.equal(retain(345), null)
  assert.deepEqual(retain(400, { eyelopen: 1 })?.values, { eyelopen: 1 })
})

test('blink tracking responds faster than torso tracking', () => {
  const bindings = createParameterBindings(['ParamEyeLOpen', 'ParamBodyAngleX'], [0, -1], [1, 1])
  const drive = createCameraParameterDriver(bindings)
  drive({ eyelopen: 1, bodyx: 1 }, 70, () => {})
  const result = []
  drive({ eyelopen: 0, bodyx: 0 }, 30, (index, value) => {
    result[index] = value
  })
  assert.ok(result[0] < result[1])
})
