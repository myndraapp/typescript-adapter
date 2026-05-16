import type { Node, Tree, GraphAPI } from '@myndra/plugin-sdk'
import { createSessionGraphCollector, type SessionGraphPayload } from '@myndra/plugin-sdk/helpers'
import type { FilePosition } from '@myndra/plugin-sdk/schemas'
import { getKindGlyph } from './glyphs'
import { buildTsNodeAttributes, TS_KINDS, hierarchyEdgeDefaults } from './kinds'
import {
  buildStableId,
  extractIdentifierName,
  findNameNode,
  isDefaultExport,
  extractGenerics,
  extractDecorators,
  normalizePath,
} from './labels'

export type SourceRange = {
  startIndex: number
  endIndex: number
}

export type SymbolEntry = {
  nodeKey: string
  kind: string
  symbolName: string | null
  fileNodeKey: string
  fileScope: string
  range: SourceRange
  nameRange: SourceRange | null
  ownerRange: SourceRange | null
  exported: boolean
  defaultExport: boolean
}

export type ImportRefRequest = {
  sourceNodeKey: string
  fileScope: string
  importSource: string
  isRelative: boolean
}

export type CallRefRequest = {
  sourceNodeKey: string
  fileScope: string
  calleeName: string
  range: SourceRange
}

export type ExtendsRefRequest = {
  sourceNodeKey: string
  fileScope: string
  targetName: string
}

export type ImplementsRefRequest = {
  sourceNodeKey: string
  fileScope: string
  targetName: string
}

export type ParsedTsFile = {
  fileNodeKey: string
  fileScope: string
  structurePayload: SessionGraphPayload
  symbolsByNodeKey: Map<string, SymbolEntry>
  symbols: {
    functions: SymbolEntry[]
    classes: SymbolEntry[]
    interfaces: SymbolEntry[]
    typeAliases: SymbolEntry[]
    enums: SymbolEntry[]
    enumMembers: SymbolEntry[]
    variables: SymbolEntry[]
    properties: SymbolEntry[]
    methods: SymbolEntry[]
    namespaces: SymbolEntry[]
    exports: SymbolEntry[]
  }
  referenceRequests: {
    imports: ImportRefRequest[]
    calls: CallRefRequest[]
    extends: ExtendsRefRequest[]
    implements: ImplementsRefRequest[]
  }
}

type ParseState = {
  graph: GraphAPI
  fileNodeKey: string
  fileScope: string
  symbolsByNodeKey: Map<string, SymbolEntry>
  symbols: ParsedTsFile['symbols']
  referenceRequests: ParsedTsFile['referenceRequests']
}

export const syntaxNodeToRange = (node: Node): SourceRange => ({
  startIndex: node.startIndex,
  endIndex: node.endIndex,
})

export const syntaxNodeToFilePosition = (node: Node): FilePosition => ({
  start: { ...node.startPosition },
  end: { ...node.endPosition },
  startIndex: node.startIndex,
  endIndex: node.endIndex,
})

const toNameRange = (node: Node | null | undefined): SourceRange | null =>
  node ? syntaxNodeToRange(node) : null

const addSymbolEntry = (
  state: ParseState,
  symbol: Omit<SymbolEntry, 'fileNodeKey' | 'fileScope'>,
) => {
  const entry: SymbolEntry = {
    ...symbol,
    fileNodeKey: state.fileNodeKey,
    fileScope: state.fileScope,
  }
  state.symbolsByNodeKey.set(entry.nodeKey, entry)
  return entry
}

const walkNode = (node: Node, visitor: (current: Node) => void) => {
  visitor(node)
  for (const child of node.namedChildren) {
    walkNode(child, visitor)
  }
}

const registerFunctionNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = extractIdentifierName(nameNode)
  const kind = TS_KINDS.FUNCTION
  const stableId = buildStableId(state.fileScope, kind, node)
  const generics = extractGenerics(node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
        generics: generics ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.functions.push(symbol)

  collectFunctionCalls(state, nodeKey, node.childForFieldName('body'))
}

const registerArrowFunctionNode = (
  state: ParseState,
  variableNode: Node,
  arrowNode: Node,
  name: string,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const kind = TS_KINDS.ARROW_FUNCTION
  const stableId = buildStableId(state.fileScope, kind, variableNode)
  const generics = extractGenerics(arrowNode)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    variableNode,
    buildTsNodeAttributes(
      { kind, label: name, image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name,
        isExported: exported,
        isDefaultExport: defaultExported,
        generics: generics ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const nameNode = findNameNode(variableNode)
  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(variableNode),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.functions.push(symbol)

  collectFunctionCalls(state, nodeKey, arrowNode.childForFieldName('body'))
}

const registerClassNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = extractIdentifierName(nameNode)
  const kind = TS_KINDS.CLASS
  const stableId = buildStableId(state.fileScope, kind, node)
  const generics = extractGenerics(node)
  const decorators = extractDecorators(node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
        generics: generics ?? undefined,
        decorators: decorators ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.classes.push(symbol)

  // Collect extends/implements references
  for (const child of node.namedChildren) {
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        collectHeritageClause(state, nodeKey, clause)
      }
    } else {
      collectHeritageClause(state, nodeKey, child)
    }
  }

  // Recurse into class body
  const body = node.childForFieldName('body')
  if (body) {
    for (const member of body.namedChildren) {
      registerClassMember(state, member, nodeKey)
    }
  }
}

const collectHeritageClause = (state: ParseState, classNodeKey: string, node: Node) => {
  if (node.type === 'extends_clause') {
    const valueNode = node.namedChildren[0]
    if (valueNode) {
      const name =
        valueNode.type === 'identifier' || valueNode.type === 'type_identifier'
          ? valueNode.text
          : null
      if (name) {
        state.referenceRequests.extends.push({
          sourceNodeKey: classNodeKey,
          fileScope: state.fileScope,
          targetName: name,
        })
      }
    }
  }

  if (node.type === 'implements_clause') {
    for (const child of node.namedChildren) {
      const name =
        child.type === 'identifier' || child.type === 'type_identifier' ? child.text : null
      if (name) {
        state.referenceRequests.implements.push({
          sourceNodeKey: classNodeKey,
          fileScope: state.fileScope,
          targetName: name,
        })
      }
    }
  }
}

const registerClassMember = (state: ParseState, node: Node, classNodeKey: string) => {
  if (node.type === 'method_definition') {
    registerMethodNode(state, node, classNodeKey)
  } else if (node.type === 'public_field_definition' || node.type === 'property_signature') {
    registerPropertyNode(state, node, classNodeKey, TS_KINDS.PROPERTY)
  }
}

const registerMethodNode = (state: ParseState, node: Node, parentKey: string) => {
  const nameNode = findNameNode(node)
  const name = nameNode?.text ?? null
  const kind = TS_KINDS.METHOD
  const stableId = buildStableId(state.fileScope, kind, node)
  const generics = extractGenerics(node)
  const decorators = extractDecorators(node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        generics: generics ?? undefined,
        decorators: decorators ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported: false,
    defaultExport: false,
  })
  state.symbols.methods.push(symbol)

  collectFunctionCalls(state, nodeKey, node.childForFieldName('body'))
}

const registerPropertyNode = (state: ParseState, node: Node, parentKey: string, kind: string) => {
  const nameNode = findNameNode(node)
  const name = nameNode?.text ?? null
  const stableId = buildStableId(state.fileScope, kind, node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(TS_KINDS.PROPERTY) },
      { stableId, symbolName: name ?? undefined },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported: false,
    defaultExport: false,
  })
  state.symbols.properties.push(symbol)
}

const registerInterfaceNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = extractIdentifierName(nameNode)
  const kind = TS_KINDS.INTERFACE
  const stableId = buildStableId(state.fileScope, kind, node)
  const generics = extractGenerics(node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
        generics: generics ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.interfaces.push(symbol)

  // Collect extends references from interface
  for (const child of node.namedChildren) {
    if (child.type === 'extends_type_clause' || child.type === 'extends_clause') {
      for (const typeChild of child.namedChildren) {
        const typeName =
          typeChild.type === 'type_identifier' || typeChild.type === 'identifier'
            ? typeChild.text
            : null
        if (typeName) {
          state.referenceRequests.extends.push({
            sourceNodeKey: nodeKey,
            fileScope: state.fileScope,
            targetName: typeName,
          })
        }
      }
    }
  }

  // Recurse into interface body
  const body = node.childForFieldName('body')
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === 'property_signature') {
        registerPropertyNode(state, member, nodeKey, TS_KINDS.PROPERTY)
      } else if (member.type === 'method_signature') {
        registerMethodNode(state, member, nodeKey)
      }
    }
  }
}

const registerTypeAliasNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = extractIdentifierName(nameNode)
  const kind = TS_KINDS.TYPE_ALIAS
  const stableId = buildStableId(state.fileScope, kind, node)
  const generics = extractGenerics(node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
        generics: generics ?? undefined,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.typeAliases.push(symbol)
}

const registerEnumNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = extractIdentifierName(nameNode)
  const kind = TS_KINDS.ENUM
  const stableId = buildStableId(state.fileScope, kind, node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'anonymous', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.enums.push(symbol)

  // Recurse into enum body for members
  const body = node.childForFieldName('body')
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === 'enum_assignment' || member.type === 'property_identifier') {
        registerEnumMemberNode(state, member, nodeKey, syntaxNodeToRange(body))
      }
    }
  }
}

const registerEnumMemberNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  ownerRange: SourceRange,
) => {
  const nameNode = findNameNode(node) ?? (node.type === 'property_identifier' ? node : null)
  const name = nameNode?.text ?? null
  const kind = TS_KINDS.ENUM_MEMBER
  const stableId = buildStableId(state.fileScope, kind, node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'member', image: getKindGlyph(kind) },
      { stableId, symbolName: name ?? undefined },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange,
    exported: false,
    defaultExport: false,
  })
  state.symbols.enumMembers.push(symbol)
}

const registerVariableNode = (
  state: ParseState,
  declarator: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
  declarationNode: Node,
) => {
  const nameNode = findNameNode(declarator)
  const name = nameNode?.text ?? extractIdentifierName(declarator.namedChildren[0]) ?? null
  const kind = TS_KINDS.VARIABLE
  const stableId = buildStableId(state.fileScope, kind, declarator)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    declarator,
    buildTsNodeAttributes(
      { kind, label: name ?? 'variable', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(declarator),
    nameRange: toNameRange(nameNode ?? declarator.namedChildren[0] ?? null),
    ownerRange: syntaxNodeToRange(declarationNode),
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.variables.push(symbol)
}

const registerNamespaceNode = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  const nameNode = findNameNode(node)
  const name = nameNode?.text ?? null
  const kind = TS_KINDS.NAMESPACE
  const stableId = buildStableId(state.fileScope, kind, node)

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label: name ?? 'namespace', image: getKindGlyph(kind) },
      {
        stableId,
        symbolName: name ?? undefined,
        isExported: exported,
        isDefaultExport: defaultExported,
      },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: name,
    range: syntaxNodeToRange(node),
    nameRange: toNameRange(nameNode),
    ownerRange: null,
    exported,
    defaultExport: defaultExported,
  })
  state.symbols.namespaces.push(symbol)

  // Recurse into namespace body
  const body = node.childForFieldName('body')
  if (body) {
    visitStatements(state, body.namedChildren, nodeKey)
  }
}

const registerExportNode = (state: ParseState, node: Node, parentKey: string) => {
  const sourceNode = findStringChild(node)
  const sourceText = sourceNode
    ? (extractStringValue(sourceNode) ?? sourceNode.text.replace(/['"]/g, ''))
    : null
  const kind = TS_KINDS.EXPORT
  const stableId = buildStableId(state.fileScope, kind, node)
  const label = sourceText ? `export from ${sourceText}` : 'export'

  const nodeKey = state.graph.derived.addTreeSitterNode(
    node,
    buildTsNodeAttributes(
      { kind, label, image: getKindGlyph(kind) },
      { stableId, isExported: true },
    ),
  )

  state.graph.durable.addHierarchyLink(parentKey, nodeKey, hierarchyEdgeDefaults)

  const symbol = addSymbolEntry(state, {
    nodeKey,
    kind,
    symbolName: label,
    range: syntaxNodeToRange(node),
    nameRange: null,
    ownerRange: null,
    exported: true,
    defaultExport: false,
  })
  state.symbols.exports.push(symbol)

  // Collect import reference for re-exports
  if (sourceText) {
    state.referenceRequests.imports.push({
      sourceNodeKey: state.fileNodeKey,
      fileScope: state.fileScope,
      importSource: sourceText,
      isRelative: sourceText.startsWith('.'),
    })
  }
}

const findStringChild = (node: Node): Node | null => {
  for (const child of node.namedChildren) {
    if (child.type === 'string' || child.type === 'string_fragment') return child
  }
  return node.childForFieldName('source')
}

const extractStringValue = (node: Node): string | null => {
  if (node.type === 'string_fragment') return node.text
  if (node.type === 'string') {
    const fragment = node.namedChildren.find((c) => c.type === 'string_fragment')
    return fragment?.text ?? node.text.replace(/['"]/g, '')
  }
  return node.text.replace(/['"]/g, '')
}

const collectImportStatement = (state: ParseState, node: Node) => {
  const sourceNode = findStringChild(node)
  if (!sourceNode) return

  const importSource = extractStringValue(sourceNode) ?? sourceNode.text.replace(/['"]/g, '')
  state.referenceRequests.imports.push({
    sourceNodeKey: state.fileNodeKey,
    fileScope: state.fileScope,
    importSource,
    isRelative: importSource.startsWith('.'),
  })
}

const collectFunctionCalls = (state: ParseState, sourceNodeKey: string, body: Node | null) => {
  if (!body) return
  walkNode(body, (current) => {
    if (current.type !== 'call_expression') return
    const fnNode = current.childForFieldName('function')
    if (!fnNode || fnNode.type !== 'identifier') return
    state.referenceRequests.calls.push({
      sourceNodeKey,
      fileScope: state.fileScope,
      calleeName: fnNode.text,
      range: syntaxNodeToRange(fnNode),
    })
  })
}

const isArrowFunctionValue = (declarator: Node): Node | null => {
  const value = declarator.childForFieldName('value')
  if (!value) return null
  if (value.type === 'arrow_function') return value
  // Handle `satisfies` or `as` wrappers
  if (value.type === 'satisfies_expression' || value.type === 'as_expression') {
    const inner = value.namedChildren[0]
    if (inner?.type === 'arrow_function') return inner
  }
  return null
}

const visitDeclaration = (
  state: ParseState,
  node: Node,
  parentKey: string,
  exported: boolean,
  defaultExported: boolean,
) => {
  switch (node.type) {
    case 'function_declaration':
    case 'function':
    case 'generator_function_declaration':
      registerFunctionNode(state, node, parentKey, exported, defaultExported)
      break

    case 'class_declaration':
      registerClassNode(state, node, parentKey, exported, defaultExported)
      break

    case 'interface_declaration':
      registerInterfaceNode(state, node, parentKey, exported, defaultExported)
      break

    case 'type_alias_declaration':
      registerTypeAliasNode(state, node, parentKey, exported, defaultExported)
      break

    case 'enum_declaration':
      registerEnumNode(state, node, parentKey, exported, defaultExported)
      break

    case 'module': // TypeScript namespace
    case 'internal_module':
      registerNamespaceNode(state, node, parentKey, exported, defaultExported)
      break

    case 'lexical_declaration':
    case 'variable_declaration':
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue
        const arrowNode = isArrowFunctionValue(declarator)
        const nameNode = findNameNode(declarator)
        const name = nameNode?.text ?? null
        if (arrowNode && name) {
          registerArrowFunctionNode(
            state,
            declarator,
            arrowNode,
            name,
            parentKey,
            exported,
            defaultExported,
          )
        } else {
          registerVariableNode(state, declarator, parentKey, exported, defaultExported, node)
        }
      }
      break

    case 'abstract_class_declaration':
      registerClassNode(state, node, parentKey, exported, defaultExported)
      break

    default:
      break
  }
}

const visitStatements = (state: ParseState, children: readonly Node[], parentKey: string) => {
  for (const child of children) {
    if (child.type === 'export_statement') {
      const declaration = child.childForFieldName('declaration')
      if (declaration) {
        visitDeclaration(state, declaration, parentKey, true, isDefaultExport(declaration))
      } else {
        // Re-export or export list
        registerExportNode(state, child, parentKey)
      }
      continue
    }

    if (child.type === 'import_statement') {
      collectImportStatement(state, child)
      continue
    }

    // Handle expression_statement wrapping internal_module (namespace)
    if (child.type === 'expression_statement') {
      for (const inner of child.namedChildren) {
        if (inner.type === 'internal_module') {
          visitDeclaration(state, inner, parentKey, false, false)
        }
      }
      continue
    }

    visitDeclaration(state, child, parentKey, false, false)
  }
}

export const buildParsedTsFile = (
  fileNodeKey: string,
  tree: Tree,
  fileScope: string,
): ParsedTsFile => {
  const collector = createSessionGraphCollector({ scopeKey: fileScope })
  const state: ParseState = {
    graph: collector.graph,
    fileNodeKey,
    fileScope,
    symbolsByNodeKey: new Map<string, SymbolEntry>(),
    symbols: {
      functions: [],
      classes: [],
      interfaces: [],
      typeAliases: [],
      enums: [],
      enumMembers: [],
      variables: [],
      properties: [],
      methods: [],
      namespaces: [],
      exports: [],
    },
    referenceRequests: {
      imports: [],
      calls: [],
      extends: [],
      implements: [],
    },
  }

  visitStatements(state, tree.rootNode.namedChildren, fileNodeKey)

  return {
    fileNodeKey,
    fileScope,
    structurePayload: collector.getPayload(),
    symbolsByNodeKey: state.symbolsByNodeKey,
    symbols: state.symbols,
    referenceRequests: state.referenceRequests,
  }
}

export const parseTsContent = async (
  ctx: import('@myndra/plugin-sdk').PluginContext,
  fileNodeKey: string,
  path: string,
  content: string,
): Promise<ParsedTsFile | null> => {
  const lowered = path.toLowerCase()
  let extension: string | null = null
  for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
    if (lowered.endsWith(ext)) {
      extension = ext
      break
    }
  }
  if (!extension) return null

  const tree = await ctx.treeSitter.parse(content, extension)
  if (!tree) {
    throw new Error('Tree-sitter TypeScript grammar not available')
  }

  return buildParsedTsFile(fileNodeKey, tree, normalizePath(path))
}
