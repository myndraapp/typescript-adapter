import { TS_KINDS, type TsKind } from './kinds'

export type AssetResolver = (name: string) => string

let resolve: AssetResolver = (name) => `./assets/${name}`

const GLYPH_FILES: Record<TsKind, string> = {
  [TS_KINDS.FUNCTION]: 'function.svg',
  [TS_KINDS.ARROW_FUNCTION]: 'arrow-function.svg',
  [TS_KINDS.CLASS]: 'class.svg',
  [TS_KINDS.METHOD]: 'method.svg',
  [TS_KINDS.INTERFACE]: 'interface.svg',
  [TS_KINDS.TYPE_ALIAS]: 'type-alias.svg',
  [TS_KINDS.ENUM]: 'enum.svg',
  [TS_KINDS.ENUM_MEMBER]: 'enum-member.svg',
  [TS_KINDS.VARIABLE]: 'variable.svg',
  [TS_KINDS.PROPERTY]: 'property.svg',
  [TS_KINDS.NAMESPACE]: 'namespace.svg',
  [TS_KINDS.EXPORT]: 'export.svg',
}

export function initializeGlyphs(assetResolver: AssetResolver) {
  resolve = assetResolver
}

export const getKindGlyph = (kind: TsKind) => resolve(GLYPH_FILES[kind])
