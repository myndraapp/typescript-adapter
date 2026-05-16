import {
  getMyndletDefaults,
  getMyndlinkDefaults,
  MyndletAttributesSchema,
  MyndlinkAttributesSchema,
  type MyndletAttributes,
  type MyndlinkAttributes,
  type Json,
} from '@myndra/plugin-sdk/schemas'

export const TS_KINDS = {
  FUNCTION: 'ts:function',
  ARROW_FUNCTION: 'ts:arrow-function',
  CLASS: 'ts:class',
  METHOD: 'ts:method',
  INTERFACE: 'ts:interface',
  TYPE_ALIAS: 'ts:type-alias',
  ENUM: 'ts:enum',
  ENUM_MEMBER: 'ts:enum-member',
  VARIABLE: 'ts:variable',
  PROPERTY: 'ts:property',
  NAMESPACE: 'ts:namespace',
  EXPORT: 'ts:export',
} as const

export type TsKind = (typeof TS_KINDS)[keyof typeof TS_KINDS]

export type TsReferenceLabel = 'import' | 'call' | 'extends' | 'implements'

export const ALL_TS_KINDS: readonly string[] = Object.values(TS_KINDS)
export const TS_EXT_NAMESPACE = 'ts-adapter'
export const TS_ADAPTER_ID = 'ts-adapter'
export const TS_NODE_COLOR = '#3178C6'

export const TS_EDGE_COLORS: Record<TsReferenceLabel, string> = {
  import: '#607D8B',
  call: '#546E7A',
  extends: '#2E7D6B',
  implements: '#00695C',
}

export type TsExt = {
  isTsFile?: boolean
  stableId?: string
  symbolName?: string
  isExported?: boolean
  isDefaultExport?: boolean
  generics?: string
  decorators?: string
  overloadCount?: number
}

export const hierarchyEdgeDefaults = getMyndlinkDefaults('hierarchy')
export const referenceEdgeDefaults = getMyndlinkDefaults('reference')

export function getTsExtFromPartial(attrs: Partial<MyndletAttributes> | null | undefined): TsExt {
  const ext = attrs?.ext?.[TS_EXT_NAMESPACE]
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {}
  const record = ext as Record<string, unknown>

  return {
    isTsFile: record.isTsFile === true,
    stableId: typeof record.stableId === 'string' ? record.stableId : undefined,
    symbolName: typeof record.symbolName === 'string' ? record.symbolName : undefined,
    isExported: record.isExported === true,
    isDefaultExport: record.isDefaultExport === true,
    generics: typeof record.generics === 'string' ? record.generics : undefined,
    decorators: typeof record.decorators === 'string' ? record.decorators : undefined,
    overloadCount: typeof record.overloadCount === 'number' ? record.overloadCount : undefined,
  }
}

export const withTsExt = (
  attrs: Partial<MyndletAttributes>,
  payload: TsExt,
): Partial<MyndletAttributes> => {
  const baseExt = { ...(attrs.ext ?? {}) }
  const tsExt: Record<string, Json> = {
    ...((baseExt[TS_EXT_NAMESPACE] as Record<string, Json>) ?? {}),
  }

  if (payload.isTsFile !== undefined) tsExt.isTsFile = payload.isTsFile
  if (payload.stableId !== undefined) tsExt.stableId = payload.stableId
  if (payload.symbolName !== undefined) tsExt.symbolName = payload.symbolName
  if (payload.isExported !== undefined) tsExt.isExported = payload.isExported
  if (payload.isDefaultExport !== undefined) tsExt.isDefaultExport = payload.isDefaultExport
  if (payload.generics !== undefined) tsExt.generics = payload.generics
  if (payload.decorators !== undefined) tsExt.decorators = payload.decorators
  if (payload.overloadCount !== undefined) tsExt.overloadCount = payload.overloadCount

  return {
    ...attrs,
    ext: {
      ...baseExt,
      [TS_EXT_NAMESPACE]: tsExt,
    },
  }
}

export const buildTsNodeAttributes = (
  attrs: Partial<MyndletAttributes>,
  payload: TsExt,
): MyndletAttributes =>
  MyndletAttributesSchema.parse(
    withTsExt(
      {
        ...getMyndletDefaults(attrs.kind ?? null),
        ...attrs,
        adapterId: TS_ADAPTER_ID,
        color: attrs.color ?? TS_NODE_COLOR,
      },
      payload,
    ),
  )

export const createReferenceEdgeAttributes = (
  label: TsReferenceLabel,
  overrides: Partial<MyndlinkAttributes> & {
    direction?: 'outgoing' | 'incoming' | 'bidirectional'
  } = {},
): MyndlinkAttributes =>
  MyndlinkAttributesSchema.parse({
    ...referenceEdgeDefaults,
    ...overrides,
    kind: 'reference',
    label,
    color: overrides.color ?? TS_EDGE_COLORS[label],
    direction: overrides.direction ?? 'outgoing',
  })

export const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

export const getTsExtension = (path: string | null | undefined) => {
  if (!path) return null
  const lowered = path.toLowerCase()
  for (const ext of TS_EXTENSIONS) {
    if (lowered.endsWith(ext)) return ext
  }
  return null
}

export const isTsFilePath = (path: string | null | undefined) => Boolean(getTsExtension(path))

export const isTsFileNode = (attrs: MyndletAttributes | Partial<MyndletAttributes>) => {
  const { isTsFile } = getTsExtFromPartial(attrs)
  return Boolean(isTsFile || getTsExtension(attrs.path))
}
