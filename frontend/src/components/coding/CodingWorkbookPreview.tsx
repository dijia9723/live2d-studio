/**
 * CodingWorkbookPreview 在浏览器中解析 XLSX 工作簿并渲染只读表格预览。
 * 解压使用 fflate，XML 采用 DOMParser，所有读取都受尺寸与行列上限约束。
 */
import { Unzip, UnzipInflate } from 'fflate'
import { useEffect, useMemo, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

// 预览上限：限制压缩包、单个 XML、累计解压体积、行数、列数与单元格长度，
// 防止构造的工作簿在渲染线程消耗过多内存或时间。
const maxArchive = 8 * 1024 * 1024
const maxXMLPart = 4 * 1024 * 1024
const maxXMLRead = 12 * 1024 * 1024
const maxRows = 200
const maxColumns = 40
const maxCellText = 1000

/** Worksheet 工作簿中一个可预览的工作表及其 ZIP 内路径。 */
type Worksheet = { name: string; path: string }
/** Workbook 解析后的工作簿：原始字节、工作表清单与共享字符串表。 */
type Workbook = { data: Uint8Array; worksheets: Worksheet[]; strings: string[] }
/** Preview 单个工作表的渲染数据与截断标记。 */
type Preview = { rows: { number: number; cells: string[] }[]; columns: number; truncated: boolean }

/** extractXMLParts 以受限方式从 ZIP 中解出指定的 XML 条目。 */
function extractXMLParts(data: Uint8Array, names: Set<string>) {
  const output = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  const sizeError = new Error('工作簿的 XML 超出预览上限')
  let archiveEntries = 0
  let expanded = 0
  const unzip = new Unzip((file) => {
    if (++archiveEntries > 4096) throw new Error('工作簿包含过多条目')
    if (!names.has(file.name)) return
    if (seen.has(file.name)) throw new Error('工作簿包含重复的 XML 条目')
    seen.add(file.name)
    if ((file.originalSize ?? 0) > maxXMLPart) throw sizeError
    const chunks: Uint8Array[] = []
    let length = 0
    file.ondata = (error, bytes, final) => {
      if (error === sizeError) throw sizeError
      if (error || !bytes) throw new Error('工作簿的 ZIP 数据无效')
      length += bytes.byteLength
      expanded += bytes.byteLength
      if (length > maxXMLPart || expanded > maxXMLRead) {
        throw sizeError
      }
      chunks.push(bytes)
      if (final) {
        const part = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          part.set(chunk, offset)
          offset += chunk.byteLength
        }
        output.set(file.name, part)
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // 分块喂入压缩数据，使单次 inflate 的瞬时输出也受控，避免 zip bomb 一次性展开。
  const chunkSize = 4096
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const end = Math.min(data.length, offset + chunkSize)
    unzip.push(data.subarray(offset, end), end === data.length)
  }
  return output
}

/** parseXML 按 BOM 选择编码解析 XML，并拒绝带 DOCTYPE/实体声明的文档。 */
function parseXML(bytes: Uint8Array | undefined, rootName: string) {
  if (!bytes) throw new Error('工作簿缺少必要的 XML 条目')
  const encoding =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
        ? 'utf-16be'
        : 'utf-8'
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  // 拒绝实体声明，防止 XXE / 实体膨胀。
  if (/<!\s*(?:doctype|entity)\b/i.test(text)) throw new Error('工作簿的 XML 包含不支持的声明')
  const xml = new DOMParser().parseFromString(text, 'application/xml')
  if (
    xml.documentElement.localName !== rootName ||
    xml.getElementsByTagName('parsererror').length
  ) {
    throw new Error('工作簿的 XML 格式无效')
  }
  return xml.documentElement
}

function child(node: Element, name: string) {
  return Array.from(node.children).find((element) => element.localName === name)
}

function relationshipPart(path: string) {
  const split = path.lastIndexOf('/') + 1
  return `${path.slice(0, split)}_rels/${path.slice(split)}.rels`
}

/** partPath 解析 OPC 关系目标路径，并拒绝目录穿越与非法字符。 */
function partPath(owner: string, target: string) {
  const segments = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const segment of target.replace(/^\//, '').split('/')) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return undefined
    }
    if (!value || /[\\/:?#\u0000-\u001f]/.test(value)) return undefined
    if (value === '.') continue
    if (value === '..') {
      if (!segments.length) return undefined
      segments.pop()
    } else {
      segments.push(value)
    }
  }
  return segments.join('/') || undefined
}

/** relationships 解析 .rels 关系文件，忽略外部模式链接。 */
function relationships(bytes: Uint8Array | undefined, owner: string) {
  if (!bytes) return []
  const root = parseXML(bytes, 'Relationships')
  return Array.from(root.children).flatMap((item) => {
    if (
      item.localName !== 'Relationship' ||
      item.getAttribute('TargetMode')?.toLowerCase() === 'external'
    )
      return []
    const id = item.getAttribute('Id')
    const type = item.getAttribute('Type')?.split('/').at(-1)
    const target = item.getAttribute('Target')
    const path = target ? partPath(owner, target) : undefined
    return id && type && path ? [{ id, type, path }] : []
  })
}

function richText(node: Element) {
  return Array.from(node.children)
    .map((element) =>
      element.localName === 't'
        ? element.textContent
        : element.localName === 'r'
          ? child(element, 't')?.textContent
          : '',
    )
    .join('')
}

/** loadWorkbook 解析包关系、工作簿清单与共享字符串表。 */
function loadWorkbook(data: Uint8Array): Workbook {
  const defaultPart = 'xl/workbook.xml'
  const packageRels = '_rels/.rels'
  const initial = extractXMLParts(
    data,
    new Set([packageRels, defaultPart, relationshipPart(defaultPart)]),
  )
  const path =
    relationships(initial.get(packageRels), '').find((item) => item.type === 'officeDocument')
      ?.path ?? defaultPart
  const relPart = relationshipPart(path)
  const workbookParts =
    path === defaultPart ? initial : extractXMLParts(data, new Set([path, relPart]))
  const xml = parseXML(workbookParts.get(path), 'workbook')
  const links = relationships(workbookParts.get(relPart), path)
  const worksheetLinks = new Map(
    links.filter((link) => link.type === 'worksheet').map((link) => [link.id, link.path]),
  )
  const sheets = child(xml, 'sheets')
  const worksheets = Array.from(sheets?.children ?? []).flatMap((sheet) => {
    if (sheet.localName !== 'sheet') return []
    const ref = Array.from(sheet.attributes).find(
      (attribute) => attribute.localName === 'id' && Boolean(attribute.namespaceURI),
    )
    const worksheet = ref && worksheetLinks.get(ref.value)
    return worksheet ? [{ name: sheet.getAttribute('name') || '工作表', path: worksheet }] : []
  })
  if (!worksheets.length) throw new Error('工作簿中没有可预览的工作表')
  const stringsPath = links.find((link) => link.type === 'sharedStrings')?.path
  const strings = stringsPath
    ? Array.from(
        parseXML(extractXMLParts(data, new Set([stringsPath])).get(stringsPath), 'sst').children,
      )
        .filter((element) => element.localName === 'si')
        .map((element) => richText(element))
    : []
  return { data, worksheets, strings }
}

/** columnNumber 把 A1 形式引用中的列字母换算为从 1 开始的列号。 */
function columnNumber(ref: string) {
  const letters = /^([A-Z]{1,3})[1-9][0-9]*$/i.exec(ref)?.[1].toUpperCase() ?? ''
  let number = 0
  for (const letter of letters) number = number * 26 + letter.charCodeAt(0) - 64
  return number
}

/** columnLabel 把列号换算回 A、B… 形式的列标题。 */
function columnLabel(number: number) {
  let label = ''
  while (number > 0) {
    number--
    label = String.fromCharCode(65 + (number % 26)) + label
    number = Math.floor(number / 26)
  }
  return label
}

/** cellValue 按单元格类型解析共享字符串、内联字符串、布尔值与公式。 */
function cellValue(cell: Element, strings: string[]) {
  const value = child(cell, 'v')?.textContent ?? ''
  switch (cell.getAttribute('t')) {
    case 's':
      return value === '' ? '' : (strings[Number(value)] ?? '')
    case 'inlineStr': {
      const inline = child(cell, 'is')
      return inline ? richText(inline) : ''
    }
    case 'b':
      return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
    default: {
      const formula = child(cell, 'f')?.textContent
      return value || (formula ? `=${formula}` : '')
    }
  }
}

/** readWorksheet 读取工作表并按行列上限截断。 */
function readWorksheet(workbook: Workbook, path: string): Preview {
  const sheet = parseXML(extractXMLParts(workbook.data, new Set([path])).get(path), 'worksheet')
  const data = child(sheet, 'sheetData')
  const rows: Preview['rows'] = []
  let columns = 0
  let number = 0
  let truncated = false
  for (const row of data?.children ?? []) {
    if (row.localName !== 'row') continue
    if (rows.length >= maxRows) {
      truncated = true
      break
    }
    const rowNumber = Number(row.getAttribute('r'))
    number =
      Number.isInteger(rowNumber) && rowNumber > 0 && rowNumber <= 1048576 ? rowNumber : number + 1
    const cells: string[] = []
    let column = 0
    for (const cell of row.children) {
      if (cell.localName !== 'c') continue
      column = columnNumber(cell.getAttribute('r') ?? '') || column + 1
      if (column > maxColumns) {
        truncated = true
        continue
      }
      columns = Math.max(columns, column)
      const value = cellValue(cell, workbook.strings)
      if (value.length > maxCellText) truncated = true
      cells[column - 1] = value.length > maxCellText ? `${value.slice(0, maxCellText)}…` : value
    }
    if (cells.length) rows.push({ number, cells })
  }
  return { rows, columns, truncated }
}

function parseError(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : '无法读取该工作簿'
}

/** CodingWorkbookPreview 以只读表格展示工作簿；blob 变化时重新解析。 */
export default function CodingWorkbookPreview({ blob }: { blob: Blob }) {
  const [loaded, setLoaded] = useState<{ blob: Blob; workbook?: Workbook; error?: string }>()
  const [selection, setSelection] = useState('')
  // 用 blob 身份比对，避免切换文件时短暂展示上一份工作簿的内容。
  const current = loaded?.blob === blob ? loaded : undefined
  const workbook = current?.workbook
  const selected =
    workbook?.worksheets.find((sheet) => sheet.path === selection) ?? workbook?.worksheets[0]

  useEffect(() => {
    let cancelled = false
    // 超过上限的文件直接拒绝解析，不再读入内存。
    if (blob.size > maxArchive) {
      setLoaded({ blob, error: '工作簿大小超出 8 MiB 预览上限' })
      return
    }
    blob
      .arrayBuffer()
      .then((array) => {
        if (!cancelled) setLoaded({ blob, workbook: loadWorkbook(new Uint8Array(array)) })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoaded({ blob, error: parseError(cause) })
      })
    return () => {
      cancelled = true
    }
  }, [blob])

  const result = useMemo(() => {
    if (!workbook || !selected) return undefined
    // 只在切换工作簿或工作表时重新解压该表，避免每次渲染都解析 XML。
    try {
      return { preview: readWorksheet(workbook, selected.path) }
    } catch (cause) {
      return { error: parseError(cause) }
    }
  }, [workbook, selected])

  if (current?.error)
    return (
      <p className="coding-alert" role="alert">
        {current.error}
      </p>
    )
  if (!workbook || !selected)
    return (
      <p className="coding-muted" role="status">
        正在读取工作簿…
      </p>
    )
  const preview = result?.preview
  const columns = Array.from({ length: preview?.columns ?? 0 }, (_, index) =>
    columnLabel(index + 1),
  )

  return (
    <div className="coding-table-preview">
      <label className="coding-file-path">
        工作表
        <Select value={selected.path} onValueChange={setSelection}>
          <SelectTrigger aria-label="工作表">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workbook.worksheets.map((sheet, index) => (
              <SelectItem key={index} value={sheet.path}>
                {sheet.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {result?.error && (
        <p className="coding-alert" role="alert">
          {result.error}
        </p>
      )}
      {preview && !preview.rows.length && (
        <p className="coding-muted">该工作表没有可预览的单元格</p>
      )}
      {preview && preview.rows.length > 0 && (
        <table aria-label={selected.name}>
          <thead>
            <tr>
              <th scope="col">行</th>
              {columns.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.number}</th>
                {columns.map((label, column) => (
                  <td key={label}>{row.cells[column]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview?.truncated && (
        <p className="coding-muted">
          预览最多显示 {maxRows} 行、{maxColumns} 列，过长的单元格内容会截断
        </p>
      )}
    </div>
  )
}
