import type { Node } from '@myndra/plugin-sdk'

export const normalizePath = (input: string) => input.replace(/\\/g, '/')

export const buildStableId = (fileScope: string, kind: string, node: Node) =>
  `ts:${fileScope}:${kind}:${node.startIndex}:${node.endIndex}`

export const extractIdentifierName = (node: Node | null | undefined): string | null => {
  if (!node) return null
  if (node.type === 'identifier' || node.type === 'property_identifier') return node.text
  if (node.type === 'type_identifier') return node.text
  return null
}

export const findNameNode = (node: Node): Node | null => node.childForFieldName('name') ?? null

export const isExported = (node: Node): boolean => {
  const parent = node.parent
  if (!parent) return false
  return parent.type === 'export_statement'
}

export const isDefaultExport = (node: Node): boolean => {
  const parent = node.parent
  if (!parent) return false
  if (parent.type !== 'export_statement') return false
  for (const child of parent.children) {
    if (child.type === 'default') return true
  }
  return false
}

export const extractGenerics = (node: Node): string | null => {
  const typeParams = node.childForFieldName('type_parameters')
  return typeParams ? typeParams.text : null
}

export const extractDecorators = (node: Node): string | null => {
  const decorators: string[] = []
  const parent = node.parent
  if (parent) {
    for (const child of parent.children) {
      if (child.type === 'decorator' && child.startIndex < node.startIndex) {
        decorators.push(child.text)
      }
    }
  }
  for (const child of node.children) {
    if (child.type === 'decorator') {
      decorators.push(child.text)
    }
  }
  return decorators.length > 0 ? decorators.join(', ') : null
}
