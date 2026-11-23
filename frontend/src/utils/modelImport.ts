/**
 * 文件职责：把用户选择的 Live2D 模型目录打包成 ZIP 上传。
 * 只保留模型运行所需的资源文件，并保留相对目录结构。
 */

// 只允许模型资源扩展名，过滤掉系统缩略图、说明文档等无关文件。
const resourceExtension = /\.(json|moc3?|mtn|physics|pose|png|jpe?g|wav|mp3|ogg|m4a|txt)$/i

/**
 * 将目录中的模型资源打包为单个 ZIP。
 * @param files input[webkitdirectory] 选中的全部文件
 * @returns 名为 model.zip 的文件，可直接上传
 */
export async function packageModelDirectory(files: File[]) {
  const resources = files.filter((file) => resourceExtension.test(file.name))
  // 空目录多半是选错位置；数量上限防止误选整个磁盘导致内存飙升。
  if (!resources.length || resources.length > 4000) {
    throw new Error('请选择单个 Live2D 模型的目录（最多 4000 个资源文件）')
  }
  const { zipSync } = await import('fflate')
  const entries: Record<string, Uint8Array> = Object.create(null)
  for (const file of resources) {
    // webkitRelativePath 保留目录层级，模型清单里的相对引用才能生效。
    entries[file.webkitRelativePath] = new Uint8Array(await file.arrayBuffer())
  }
  // 图片/音频等本身已压缩，level 0 只做存储可显著加快打包。
  const archive = zipSync(entries, { level: 0 })
  return new File([archive as Uint8Array<ArrayBuffer>], 'model.zip', { type: 'application/zip' })
}
