/// <reference types="vite/client" />
import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe-vision-wasm/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe-vision-wasm/vision_wasm_internal.wasm?url'
import faceModel from '../assets/tracking/face_landmarker.task?url'
import poseModel from '../assets/tracking/pose_landmarker_lite.task?url'

export async function openCameraLandmarkers(signal: AbortSignal) {
  signal.throwIfAborted()
  if (!(await FilesetResolver.isSimdSupported())) throw new DOMException('', 'NotSupportedError')
  signal.throwIfAborted()
  const wasm = { wasmLoaderPath, wasmBinaryPath }
  const face = await FaceLandmarker.createFromOptions(wasm, {
    baseOptions: { modelAssetPath: faceModel, delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  })
  try {
    signal.throwIfAborted()
    const pose = await PoseLandmarker.createFromOptions(wasm, {
      baseOptions: { modelAssetPath: poseModel, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    })
    return {
      face,
      pose,
      close() {
        try {
          pose.close()
        } finally {
          face.close()
        }
      },
    }
  } catch (error) {
    face.close()
    throw error
  }
}
