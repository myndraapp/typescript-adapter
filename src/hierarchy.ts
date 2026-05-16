import type { MyndletAttributes } from '@myndra/plugin-sdk/schemas'
import type { PluginContext } from '@myndra/plugin-sdk'
import {
  collectExternalDependents,
  collectRenameRanges,
  DELETEABLE_KINDS,
  isDeleteableSymbol,
  isRenameableSymbol,
  type WorkspaceSymbolIndex,
} from './references'
import { TS_ADAPTER_ID, TS_KINDS, isTsFileNode, type TsKind } from './kinds'
import type { ParsedTsFile, SymbolEntry } from './treeParser'

export { TS_ADAPTER_ID }

type StructureDeleteContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  parentKey: string | null
}

type StructureRenameContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentName: string
  newName: string
}

type ResolvedSymbolNode = {
  fileNodeKey: string
  filePath: string
  entry: ParsedTsFile
  symbol: SymbolEntry
}

type AdapterRuntime = {
  resolveSymbolNode(nodeKey: string): Promise<ResolvedSymbolNode | null>
  ensureWorkspaceIndex(): Promise<WorkspaceSymbolIndex>
  commitMutation(fileNodeKey: string, filePath: string, nextContent: string): Promise<void>
}

const sortDescending = <T extends { startIndex: number; endIndex: number }>(ranges: T[]) =>
  ranges.slice().sort((a, b) => b.startIndex - a.startIndex || b.endIndex - a.endIndex)

export const applyTextReplacements = (
  content: string,
  ranges: Array<{ startIndex: number; endIndex: number }>,
  replacement: string,
) => {
  let nextContent = content
  for (const range of sortDescending(ranges)) {
    nextContent =
      nextContent.slice(0, range.startIndex) + replacement + nextContent.slice(range.endIndex)
  }
  return nextContent
}

const removeWholeRange = (content: string, range: { startIndex: number; endIndex: number }) => {
  let start = range.startIndex
  let end = range.endIndex

  while (start > 0 && (content[start - 1] === ' ' || content[start - 1] === '\t')) {
    start -= 1
  }

  if (start > 0 && content[start - 1] === '\n') {
    start -= 1
  }

  while (end < content.length && (content[end] === ' ' || content[end] === '\t')) {
    end += 1
  }
  if (end < content.length && content[end] === '\n') {
    end += 1
  }

  return content.slice(0, start) + content.slice(end)
}

const removeDelimitedRange = (
  content: string,
  range: { startIndex: number; endIndex: number },
  ownerRange: { startIndex: number; endIndex: number },
) => {
  const start = range.startIndex
  let end = range.endIndex

  while (end < ownerRange.endIndex && /\s/.test(content[end] ?? '')) {
    end += 1
  }
  if (content[end] === ',') {
    end += 1
    while (end < ownerRange.endIndex && /\s/.test(content[end] ?? '')) {
      end += 1
    }
    return content.slice(0, start) + content.slice(end)
  }

  let back = start
  while (back > ownerRange.startIndex && /\s/.test(content[back - 1] ?? '')) {
    back -= 1
  }
  if (content[back - 1] === ',') {
    back -= 1
    while (back > ownerRange.startIndex && /\s/.test(content[back - 1] ?? '')) {
      back -= 1
    }
    return content.slice(0, back) + content.slice(end)
  }

  return removeWholeRange(content, range)
}

export const deleteSymbolFromContent = (content: string, symbol: SymbolEntry) => {
  if (symbol.kind === TS_KINDS.ENUM_MEMBER) {
    if (!symbol.ownerRange) {
      throw new Error('Enum member is missing its owner range')
    }
    return removeDelimitedRange(content, symbol.range, symbol.ownerRange)
  }

  const deleteRange = symbol.ownerRange ?? symbol.range
  return removeWholeRange(content, deleteRange)
}

export const findTsFileRoot = (ctx: PluginContext, nodeKey: string) => {
  let currentKey: string | null = nodeKey
  while (currentKey) {
    const node = ctx.graph.getNode(currentKey)
    if (!node) return null
    if (isTsFileNode(node.attributes) && node.attributes.path) {
      return node
    }
    currentKey = ctx.graph.getParent(currentKey)
  }
  return null
}

export const createTsAdapter = (ctx: PluginContext, runtime: AdapterRuntime) => ({
  id: TS_ADAPTER_ID,
  name: 'TypeScript File Adapter',
  supportedChildKinds: Array.from(DELETEABLE_KINDS).filter((kind): kind is TsKind => true),
  supportedParentKinds: [
    TS_KINDS.CLASS,
    TS_KINDS.INTERFACE,
    TS_KINDS.ENUM,
    TS_KINDS.NAMESPACE,
    'file',
  ],

  async applyDelete({ nodeKey }: StructureDeleteContext) {
    const resolved = await runtime.resolveSymbolNode(nodeKey)
    if (!resolved) {
      return { success: false, error: 'Could not locate TypeScript symbol' }
    }

    const { fileNodeKey, filePath, entry, symbol } = resolved
    if (!isDeleteableSymbol(symbol)) {
      return { success: false, error: 'Delete is not supported for this TypeScript node' }
    }

    const workspaceIndex = await runtime.ensureWorkspaceIndex()
    const dependents = collectExternalDependents(symbol, workspaceIndex)
    if (dependents.length > 0) {
      const files = dependents.map((dependent) => dependent.fileScope).join(', ')
      const label = symbol.symbolName ?? symbol.kind
      ctx.ui.notify(`Cannot delete ${label}; referenced by ${files}`, 'warning')
      return { success: false, error: `Dependent references found outside ${entry.fileScope}` }
    }

    const content = await ctx.files.readFile(filePath)
    const nextContent = deleteSymbolFromContent(content, symbol)
    await runtime.commitMutation(fileNodeKey, filePath, nextContent)
    return { success: true }
  },

  async applyRename({ nodeKey, newName }: StructureRenameContext) {
    const resolved = await runtime.resolveSymbolNode(nodeKey)
    if (!resolved) {
      return { success: false, error: 'Could not locate TypeScript symbol' }
    }

    const { fileNodeKey, filePath, entry, symbol } = resolved
    if (!isRenameableSymbol(symbol)) {
      return { success: false, error: 'Rename is not supported for this TypeScript node' }
    }
    if (!symbol.nameRange) {
      return { success: false, error: 'Symbol is missing a rename range' }
    }

    const workspaceIndex = await runtime.ensureWorkspaceIndex()
    const ranges = collectRenameRanges(entry, symbol, workspaceIndex)
    if (ranges.length === 0) {
      return { success: false, error: 'Could not find rename targets in the source file' }
    }

    const content = await ctx.files.readFile(filePath)
    const nextContent = applyTextReplacements(content, ranges, newName.trim())
    await runtime.commitMutation(fileNodeKey, filePath, nextContent)
    return { success: true }
  },
})
