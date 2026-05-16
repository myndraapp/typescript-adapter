import type { SessionGraphPayload } from '@myndra/plugin-sdk/helpers'
import { createReferenceEdgeAttributes, TS_KINDS, type TsReferenceLabel } from './kinds'
import { normalizePath } from './labels'
import type {
  CallRefRequest,
  ExtendsRefRequest,
  ImplementsRefRequest,
  ParsedTsFile,
  SymbolEntry,
} from './treeParser'

export type IndexedTsFile = {
  nodeKey: string
  path: string
}

export type ExternalDependent = {
  fileScope: string
  reason: string
}

export type WorkspaceSymbolIndex = {
  files: IndexedTsFile[]
  filesByPath: Map<string, IndexedTsFile>
  entries: ParsedTsFile[]
  entryByFileNodeKey: Map<string, ParsedTsFile>
  symbolByNodeKey: Map<string, SymbolEntry>
  functionsByName: Map<string, SymbolEntry[]>
  classesByName: Map<string, SymbolEntry[]>
  interfacesByName: Map<string, SymbolEntry[]>
  typesByName: Map<string, SymbolEntry[]>
}

const stableHash = (value: string): string => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const addToNameIndex = (
  index: Map<string, SymbolEntry[]>,
  symbolName: string | null,
  entry: SymbolEntry,
) => {
  if (!symbolName) return
  const list = index.get(symbolName) ?? []
  list.push(entry)
  index.set(symbolName, list)
}

export const buildWorkspaceIndex = (
  files: IndexedTsFile[],
  entries: Iterable<ParsedTsFile>,
): WorkspaceSymbolIndex => {
  const parsedEntries = Array.from(entries)
  const filesByPath = new Map<string, IndexedTsFile>()
  for (const file of files) {
    filesByPath.set(normalizePath(file.path), file)
  }

  const symbolByNodeKey = new Map<string, SymbolEntry>()
  const functionsByName = new Map<string, SymbolEntry[]>()
  const classesByName = new Map<string, SymbolEntry[]>()
  const interfacesByName = new Map<string, SymbolEntry[]>()
  const typesByName = new Map<string, SymbolEntry[]>()

  for (const entry of parsedEntries) {
    for (const symbol of entry.symbols.functions) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
      addToNameIndex(functionsByName, symbol.symbolName, symbol)
    }
    for (const symbol of entry.symbols.classes) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
      addToNameIndex(classesByName, symbol.symbolName, symbol)
      addToNameIndex(typesByName, symbol.symbolName, symbol)
    }
    for (const symbol of entry.symbols.interfaces) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
      addToNameIndex(interfacesByName, symbol.symbolName, symbol)
      addToNameIndex(typesByName, symbol.symbolName, symbol)
    }
    for (const symbol of entry.symbols.typeAliases) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
      addToNameIndex(typesByName, symbol.symbolName, symbol)
    }
    for (const symbol of entry.symbols.enums) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
      addToNameIndex(typesByName, symbol.symbolName, symbol)
    }
    for (const symbol of entry.symbols.variables) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
    for (const symbol of entry.symbols.methods) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
    for (const symbol of entry.symbols.properties) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
    for (const symbol of entry.symbols.enumMembers) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
    for (const symbol of entry.symbols.namespaces) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
    for (const symbol of entry.symbols.exports) {
      symbolByNodeKey.set(symbol.nodeKey, symbol)
    }
  }

  return {
    files,
    filesByPath,
    entries: parsedEntries,
    entryByFileNodeKey: new Map(parsedEntries.map((entry) => [entry.fileNodeKey, entry])),
    symbolByNodeKey,
    functionsByName,
    classesByName,
    interfacesByName,
    typesByName,
  }
}

const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const INDEX_SUFFIXES = IMPORT_EXTENSIONS.map((ext) => `/index${ext}`)

const resolveImportTarget = (
  fileScope: string,
  importSource: string,
  index: WorkspaceSymbolIndex,
): string | null => {
  const slashIndex = fileScope.lastIndexOf('/')
  const dir = slashIndex >= 0 ? fileScope.slice(0, slashIndex + 1) : ''
  const rawCandidate = `${dir}${importSource}`
  // Simplify path segments (resolve ./  and ../)
  const parts = rawCandidate.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      resolved.pop()
      continue
    }
    resolved.push(part)
  }
  const candidate = resolved.join('/')

  // Exact match
  const exact = index.filesByPath.get(candidate)
  if (exact) return exact.nodeKey

  // Try with extensions
  for (const ext of IMPORT_EXTENSIONS) {
    const withExt = index.filesByPath.get(`${candidate}${ext}`)
    if (withExt) return withExt.nodeKey
  }

  // Try as directory with index file
  for (const suffix of INDEX_SUFFIXES) {
    const withIndex = index.filesByPath.get(`${candidate}${suffix}`)
    if (withIndex) return withIndex.nodeKey
  }

  // Fall back to absolute matching
  const normalized = normalizePath(importSource)
  for (const ext of [...IMPORT_EXTENSIONS, '']) {
    const target = `${normalized}${ext}`
    const match = index.files.find((file) => {
      const norm = normalizePath(file.path)
      return norm === target || norm.endsWith(`/${target}`)
    })
    if (match) return match.nodeKey
  }

  return null
}

const resolveCallTarget = (request: CallRefRequest, index: WorkspaceSymbolIndex) => {
  const candidates = index.functionsByName.get(request.calleeName) ?? []
  if (candidates.length === 0) return null

  // Prefer same-file match
  const sameFile = candidates.filter((candidate) => candidate.fileScope === request.fileScope)
  if (sameFile.length === 1) return sameFile[0]
  return candidates.length === 1 ? candidates[0] : null
}

const resolveExtendsTarget = (request: ExtendsRefRequest, index: WorkspaceSymbolIndex) => {
  const candidates = index.typesByName.get(request.targetName) ?? []
  if (candidates.length === 0) return null

  const sameFile = candidates.filter((candidate) => candidate.fileScope === request.fileScope)
  if (sameFile.length === 1) return sameFile[0]
  return candidates.length === 1 ? candidates[0] : null
}

const resolveImplementsTarget = (request: ImplementsRefRequest, index: WorkspaceSymbolIndex) => {
  const candidates = index.interfacesByName.get(request.targetName) ?? []
  if (candidates.length === 0) return null

  const sameFile = candidates.filter((candidate) => candidate.fileScope === request.fileScope)
  if (sameFile.length === 1) return sameFile[0]
  return candidates.length === 1 ? candidates[0] : null
}

const referenceEdgeKey = (label: TsReferenceLabel, source: string, target: string) =>
  `ts_ref_${stableHash(`${label}:${source}:${target}`)}`

const addReferenceEdge = (
  sink: Map<string, SessionGraphPayload['edges'][number]>,
  label: TsReferenceLabel,
  source: string,
  target: string,
) => {
  if (source === target) return
  const key = referenceEdgeKey(label, source, target)
  if (sink.has(key)) return
  sink.set(key, {
    key,
    source,
    target,
    attributes: createReferenceEdgeAttributes(label),
  })
}

export const buildResolvedPayload = (
  entry: ParsedTsFile,
  index: WorkspaceSymbolIndex,
): SessionGraphPayload => {
  const edges = new Map(entry.structurePayload.edges.map((edge) => [edge.key, edge]))

  for (const importReq of entry.referenceRequests.imports) {
    if (!importReq.isRelative) continue
    const target = resolveImportTarget(importReq.fileScope, importReq.importSource, index)
    if (target) {
      addReferenceEdge(edges, 'import', importReq.sourceNodeKey, target)
    }
  }

  for (const call of entry.referenceRequests.calls) {
    const target = resolveCallTarget(call, index)
    if (!target) continue
    addReferenceEdge(edges, 'call', call.sourceNodeKey, target.nodeKey)
  }

  for (const extendsReq of entry.referenceRequests.extends) {
    const target = resolveExtendsTarget(extendsReq, index)
    if (!target) continue
    addReferenceEdge(edges, 'extends', extendsReq.sourceNodeKey, target.nodeKey)
  }

  for (const implReq of entry.referenceRequests.implements) {
    const target = resolveImplementsTarget(implReq, index)
    if (!target) continue
    addReferenceEdge(edges, 'implements', implReq.sourceNodeKey, target.nodeKey)
  }

  return {
    nodes: [...entry.structurePayload.nodes],
    edges: Array.from(edges.values()),
  }
}

export const mergeRenderPayloads = (
  payloads: Iterable<SessionGraphPayload>,
): SessionGraphPayload => {
  const nodes = new Map<string, SessionGraphPayload['nodes'][number]>()
  const edges = new Map<string, SessionGraphPayload['edges'][number]>()

  for (const payload of payloads) {
    for (const node of payload.nodes) nodes.set(node.key, node)
    for (const edge of payload.edges) edges.set(edge.key, edge)
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  }
}

const uniqueRanges = (ranges: Array<{ startIndex: number; endIndex: number }>) => {
  const seen = new Set<string>()
  return ranges.filter((range) => {
    const key = `${range.startIndex}:${range.endIndex}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const isDeleteableSymbol = (symbol: SymbolEntry) => DELETEABLE_KINDS.has(symbol.kind)

export const isRenameableSymbol = (symbol: SymbolEntry) =>
  RENAMEABLE_KINDS.has(symbol.kind) && symbol.nameRange !== null

export const DELETEABLE_KINDS = new Set<string>([
  TS_KINDS.FUNCTION,
  TS_KINDS.ARROW_FUNCTION,
  TS_KINDS.CLASS,
  TS_KINDS.METHOD,
  TS_KINDS.INTERFACE,
  TS_KINDS.TYPE_ALIAS,
  TS_KINDS.ENUM,
  TS_KINDS.ENUM_MEMBER,
  TS_KINDS.VARIABLE,
  TS_KINDS.PROPERTY,
  TS_KINDS.NAMESPACE,
  TS_KINDS.EXPORT,
])

export const RENAMEABLE_KINDS = new Set<string>([
  TS_KINDS.FUNCTION,
  TS_KINDS.ARROW_FUNCTION,
  TS_KINDS.CLASS,
  TS_KINDS.METHOD,
  TS_KINDS.INTERFACE,
  TS_KINDS.TYPE_ALIAS,
  TS_KINDS.ENUM,
  TS_KINDS.ENUM_MEMBER,
  TS_KINDS.VARIABLE,
  TS_KINDS.PROPERTY,
  TS_KINDS.NAMESPACE,
])

export const collectRenameRanges = (
  entry: ParsedTsFile,
  target: SymbolEntry,
  index: WorkspaceSymbolIndex,
) => {
  const ranges: Array<{ startIndex: number; endIndex: number }> = []
  if (target.nameRange) ranges.push(target.nameRange)

  if (!target.symbolName) return uniqueRanges(ranges)

  // For functions / arrow functions, collect intra-file call sites
  if (target.kind === TS_KINDS.FUNCTION || target.kind === TS_KINDS.ARROW_FUNCTION) {
    for (const call of entry.referenceRequests.calls) {
      if (resolveCallTarget(call, index)?.nodeKey === target.nodeKey) {
        ranges.push(call.range)
      }
    }
  }

  return uniqueRanges(ranges)
}

export const collectExternalDependents = (
  target: SymbolEntry,
  index: WorkspaceSymbolIndex,
): ExternalDependent[] => {
  const dependents: ExternalDependent[] = []
  if (!target.symbolName) return dependents

  const otherEntries = index.entries.filter((entry) => entry.fileNodeKey !== target.fileNodeKey)

  if (target.kind === TS_KINDS.FUNCTION || target.kind === TS_KINDS.ARROW_FUNCTION) {
    for (const entry of otherEntries) {
      if (
        entry.referenceRequests.calls.some(
          (call) => resolveCallTarget(call, index)?.nodeKey === target.nodeKey,
        )
      ) {
        dependents.push({ fileScope: entry.fileScope, reason: 'call' })
      }
    }
  }

  return dependents
}
