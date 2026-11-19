const resourceExtension = /\.(json|moc3?|mtn|physics|pose|png|jpe?g|wav|mp3|ogg|m4a|txt)$/i

export async function packageModelDirectory(files: File[]) {
  const resources = files.filter((file) => resourceExtension.test(file.name))
  if (!resources.length || resources.length > 4000) {
    throw new Error('请选择单个 Live2D 模型的目录（最多 4000 个资源文件）')
  }
  const { zipSync } = await import('fflate')
  const entries: Record<string, Uint8Array> = Object.create(null)
  for (const file of resources) {
    entries[file.webkitRelativePath] = new Uint8Array(await file.arrayBuffer())
  }
  const archive = zipSync(entries, { level: 0 })
  return new File([archive as Uint8Array<ArrayBuffer>], 'model.zip', { type: 'application/zip' })
}
