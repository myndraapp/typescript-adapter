import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Language, Parser } from 'web-tree-sitter'
import { applyTextReplacements, deleteSymbolFromContent } from './hierarchy'
import { buildResolvedPayload, buildWorkspaceIndex, collectRenameRanges } from './references'
import { TS_KINDS } from './kinds'
import { buildParsedTsFile } from './treeParser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')
const treeSitterWasm = path.join(repoRoot, 'node_modules/web-tree-sitter/web-tree-sitter.wasm')
const tsxGrammarWasm = path.join(__dirname, '../assets/tree-sitter-tsx.wasm')

let parser: Parser

const parseFile = (fileNodeKey: string, fileScope: string, content: string) => {
  const tree = parser.parse(content)
  if (!tree) throw new Error(`Failed to parse ${fileScope}`)
  return buildParsedTsFile(fileNodeKey, tree, fileScope)
}

const findSymbol = (entry: ReturnType<typeof parseFile>, kind: string, name: string) => {
  for (const collection of Object.values(entry.symbols)) {
    const match = collection.find((symbol) => symbol.kind === kind && symbol.symbolName === name)
    if (match) return match
  }
  return null
}

beforeAll(async () => {
  await Parser.init({
    locateFile: () => treeSitterWasm,
  })
  const language = await Language.load(new Uint8Array(readFileSync(tsxGrammarWasm)))
  parser = new Parser()
  parser.setLanguage(language)
})

describe('typescript-adapter', () => {
  it('parses functions, classes, interfaces, enums, and type aliases', () => {
    const content = `
function greet(name: string): string {
  return \`Hello, \${name}\`
}

class Animal {
  name: string
  speak(): void {}
}

interface Runnable {
  run(): void
}

type ID = string | number

enum Direction {
  Up,
  Down,
  Left,
  Right,
}

const MAX_SIZE = 100
`

    const entry = parseFile('file1', 'src/example.ts', content)

    expect(findSymbol(entry, TS_KINDS.FUNCTION, 'greet')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.CLASS, 'Animal')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.METHOD, 'speak')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.PROPERTY, 'name')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.INTERFACE, 'Runnable')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.TYPE_ALIAS, 'ID')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.ENUM, 'Direction')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.VARIABLE, 'MAX_SIZE')).not.toBeNull()

    // Enum members
    expect(findSymbol(entry, TS_KINDS.ENUM_MEMBER, 'Up')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.ENUM_MEMBER, 'Down')).not.toBeNull()

    // Hierarchy edges: file → function, file → class, class → method, class → property
    const hierarchyEdges = entry.structurePayload.edges.filter(
      (e) => e.attributes.kind === 'hierarchy',
    )
    expect(hierarchyEdges.length).toBeGreaterThan(0)

    // Verify class → method hierarchy edge exists
    const classSymbol = findSymbol(entry, TS_KINDS.CLASS, 'Animal')!
    const methodSymbol = findSymbol(entry, TS_KINDS.METHOD, 'speak')!
    const classMethodEdge = hierarchyEdges.find(
      (e) => e.source === classSymbol.nodeKey && e.target === methodSymbol.nodeKey,
    )
    expect(classMethodEdge).toBeDefined()
  })

  it('parses arrow functions assigned to variables', () => {
    const content = `
const add = (a: number, b: number) => a + b
const multiply = (a: number, b: number) => {
  return a * b
}
`

    const entry = parseFile('file1', 'src/arrows.ts', content)

    const addSymbol = findSymbol(entry, TS_KINDS.ARROW_FUNCTION, 'add')
    expect(addSymbol).not.toBeNull()
    expect(addSymbol!.symbolName).toBe('add')

    const multiplySymbol = findSymbol(entry, TS_KINDS.ARROW_FUNCTION, 'multiply')
    expect(multiplySymbol).not.toBeNull()
    expect(multiplySymbol!.symbolName).toBe('multiply')
  })

  it('parses import statements and resolves relative imports', () => {
    const mainContent = `
import { helper } from './utils'
import lodash from 'lodash'

function main() {
  helper()
}
`

    const utilsContent = `
export function helper() {
  return 42
}
`

    const mainEntry = parseFile('file-main', 'src/main.ts', mainContent)
    const utilsEntry = parseFile('file-utils', 'src/utils.ts', utilsContent)

    // Import reference requests collected
    expect(mainEntry.referenceRequests.imports.length).toBe(2)

    const relativeImport = mainEntry.referenceRequests.imports.find(
      (req) => req.importSource === './utils',
    )
    expect(relativeImport).toBeDefined()
    expect(relativeImport!.isRelative).toBe(true)

    const bareImport = mainEntry.referenceRequests.imports.find(
      (req) => req.importSource === 'lodash',
    )
    expect(bareImport).toBeDefined()
    expect(bareImport!.isRelative).toBe(false)

    // Build index and resolve
    const index = buildWorkspaceIndex(
      [
        { nodeKey: 'file-main', path: 'src/main.ts' },
        { nodeKey: 'file-utils', path: 'src/utils.ts' },
      ],
      [mainEntry, utilsEntry],
    )

    const payload = buildResolvedPayload(mainEntry, index)
    const importEdge = payload.edges.find(
      (e) => e.attributes.kind === 'reference' && e.attributes.label === 'import',
    )
    expect(importEdge).toBeDefined()
    expect(importEdge!.source).toBe('file-main')
    expect(importEdge!.target).toBe('file-utils')
  })

  it('parses extends and implements references', () => {
    const content = `
interface Serializable {
  serialize(): string
}

class Base {
  id: number
}

class Derived extends Base implements Serializable {
  serialize(): string {
    return ''
  }
}
`

    const entry = parseFile('file1', 'src/classes.ts', content)

    expect(entry.referenceRequests.extends.length).toBeGreaterThanOrEqual(1)
    expect(entry.referenceRequests.implements.length).toBeGreaterThanOrEqual(1)

    const extendsReq = entry.referenceRequests.extends.find((req) => req.targetName === 'Base')
    expect(extendsReq).toBeDefined()

    const implReq = entry.referenceRequests.implements.find(
      (req) => req.targetName === 'Serializable',
    )
    expect(implReq).toBeDefined()

    // Verify edges are resolved
    const index = buildWorkspaceIndex([{ nodeKey: 'file1', path: 'src/classes.ts' }], [entry])
    const payload = buildResolvedPayload(entry, index)

    const extendsEdge = payload.edges.find(
      (e) => e.attributes.kind === 'reference' && e.attributes.label === 'extends',
    )
    expect(extendsEdge).toBeDefined()

    const implEdge = payload.edges.find(
      (e) => e.attributes.kind === 'reference' && e.attributes.label === 'implements',
    )
    expect(implEdge).toBeDefined()
  })

  it('parses a TSX file without crashing', () => {
    const content = `
import React from 'react'

interface Props {
  name: string
}

const Greeting = ({ name }: Props) => {
  return <div>Hello, {name}</div>
}

export default Greeting
`

    const entry = parseFile('file1', 'src/Greeting.tsx', content)

    // Should parse without error
    expect(entry.symbols.interfaces.length).toBe(1)
    expect(findSymbol(entry, TS_KINDS.INTERFACE, 'Props')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.ARROW_FUNCTION, 'Greeting')).not.toBeNull()
  })

  it('produces no nodes for an empty file', () => {
    const entry = parseFile('file1', 'src/empty.ts', '')
    expect(entry.structurePayload.nodes.length).toBe(0)
    expect(entry.structurePayload.edges.length).toBe(0)
  })

  it('detects export status on declarations', () => {
    const content = `
export function exported() {}
export default function defaultExported() {}
function internal() {}
`

    const entry = parseFile('file1', 'src/exports.ts', content)

    const exportedSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'exported')
    expect(exportedSymbol).not.toBeNull()
    expect(exportedSymbol!.exported).toBe(true)
    expect(exportedSymbol!.defaultExport).toBe(false)

    const defaultSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'defaultExported')
    expect(defaultSymbol).not.toBeNull()
    expect(defaultSymbol!.exported).toBe(true)

    const internalSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'internal')
    expect(internalSymbol).not.toBeNull()
    expect(internalSymbol!.exported).toBe(false)
  })

  it('parses namespaces with nested declarations', () => {
    const content = `
namespace MyNamespace {
  export function inner() {}
  export class InnerClass {}
}
`

    const entry = parseFile('file1', 'src/ns.ts', content)

    expect(findSymbol(entry, TS_KINDS.NAMESPACE, 'MyNamespace')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.FUNCTION, 'inner')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.CLASS, 'InnerClass')).not.toBeNull()

    // Hierarchy: namespace → function, namespace → class
    const nsSymbol = findSymbol(entry, TS_KINDS.NAMESPACE, 'MyNamespace')!
    const innerSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'inner')!
    const hierarchyEdges = entry.structurePayload.edges.filter(
      (e) => e.attributes.kind === 'hierarchy',
    )
    const nsToInner = hierarchyEdges.find(
      (e) => e.source === nsSymbol.nodeKey && e.target === innerSymbol.nodeKey,
    )
    expect(nsToInner).toBeDefined()
  })

  it('collects intra-file call references', () => {
    const content = `
function helper() {
  return 1
}

function main() {
  return helper()
}
`

    const entry = parseFile('file1', 'src/calls.ts', content)

    const index = buildWorkspaceIndex([{ nodeKey: 'file1', path: 'src/calls.ts' }], [entry])
    const payload = buildResolvedPayload(entry, index)

    const callEdge = payload.edges.find(
      (e) => e.attributes.kind === 'reference' && e.attributes.label === 'call',
    )
    expect(callEdge).toBeDefined()

    const mainSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'main')!
    const helperSymbol = findSymbol(entry, TS_KINDS.FUNCTION, 'helper')!
    expect(callEdge!.source).toBe(mainSymbol.nodeKey)
    expect(callEdge!.target).toBe(helperSymbol.nodeKey)
  })

  it('deletes a function from file content', () => {
    const content = `function keep() {}\nfunction remove() {}\nfunction alsoKeep() {}\n`

    const entry = parseFile('file1', 'src/del.ts', content)
    const symbol = findSymbol(entry, TS_KINDS.FUNCTION, 'remove')!

    const result = deleteSymbolFromContent(content, symbol)
    expect(result).toContain('function keep()')
    expect(result).toContain('function alsoKeep()')
    expect(result).not.toContain('function remove()')
  })

  it('renames a function and its call sites', () => {
    const content = `function oldName() {}\nfunction caller() {\n  oldName()\n}\n`

    const entry = parseFile('file1', 'src/rename.ts', content)
    const symbol = findSymbol(entry, TS_KINDS.FUNCTION, 'oldName')!

    const index = buildWorkspaceIndex([{ nodeKey: 'file1', path: 'src/rename.ts' }], [entry])

    const ranges = collectRenameRanges(entry, symbol, index)
    expect(ranges.length).toBe(2) // definition + call site

    const result = applyTextReplacements(content, ranges, 'newName')
    expect(result).toContain('function newName()')
    expect(result).toContain('newName()')
    expect(result).not.toContain('oldName')
  })

  it('parses re-export statements', () => {
    const content = `
export { foo, bar } from './other'
export * from './all'
`

    const entry = parseFile('file1', 'src/reexports.ts', content)

    expect(entry.symbols.exports.length).toBe(2)
    expect(entry.referenceRequests.imports.length).toBe(2)
  })

  it('parses interface members as property nodes', () => {
    const content = `
interface Config {
  name: string
  value: number
}
`

    const entry = parseFile('file1', 'src/iface.ts', content)

    expect(findSymbol(entry, TS_KINDS.INTERFACE, 'Config')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.PROPERTY, 'name')).not.toBeNull()
    expect(findSymbol(entry, TS_KINDS.PROPERTY, 'value')).not.toBeNull()
  })
})
