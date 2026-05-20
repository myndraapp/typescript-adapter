import type { MyndraPluginModule } from '@myndra/plugin-sdk'
import { javascript } from '@codemirror/lang-javascript'
import { createTsAdapter, findTsFileRoot } from './hierarchy'
import { initializeGlyphs, getKindGlyph } from './glyphs'
import {
  buildResolvedPayload,
  buildWorkspaceIndex,
  mergeRenderPayloads,
  type IndexedTsFile,
} from './references'
import { TS_KINDS, TS_EXTENSIONS, isTsFilePath } from './kinds'
import { normalizePath } from './labels'
import { parseTsContent, type ParsedTsFile } from './treeParser'

const MATCHER_ID = 'ts-adapter.files'

let registeredMatcherId: string | null = null
let unregisterMatcher: (() => void) | null = null
let clearSessionData: (() => void) | null = null

const plugin: MyndraPluginModule = {
  extensions: () => TS_EXTENSIONS,

  async activate(ctx) {
    // Register CodeMirror syntax for all TS/JS extensions
    for (const ext of ['.ts', '.tsx']) {
      ctx.editor.registerExtensions(ext, [javascript({ typescript: true, jsx: ext === '.tsx' })])
    }
    for (const ext of ['.js', '.jsx']) {
      ctx.editor.registerExtensions(ext, [javascript({ jsx: ext === '.jsx' })])
    }

    initializeGlyphs((name) => ctx.resolveAsset(`assets/${name}`))
    ctx.glyphs.register(TS_KINDS.FUNCTION, getKindGlyph(TS_KINDS.FUNCTION))
    ctx.glyphs.register(TS_KINDS.ARROW_FUNCTION, getKindGlyph(TS_KINDS.ARROW_FUNCTION))
    ctx.glyphs.register(TS_KINDS.CLASS, getKindGlyph(TS_KINDS.CLASS))
    ctx.glyphs.register(TS_KINDS.METHOD, getKindGlyph(TS_KINDS.METHOD))
    ctx.glyphs.register(TS_KINDS.INTERFACE, getKindGlyph(TS_KINDS.INTERFACE))
    ctx.glyphs.register(TS_KINDS.TYPE_ALIAS, getKindGlyph(TS_KINDS.TYPE_ALIAS))
    ctx.glyphs.register(TS_KINDS.ENUM, getKindGlyph(TS_KINDS.ENUM))
    ctx.glyphs.register(TS_KINDS.ENUM_MEMBER, getKindGlyph(TS_KINDS.ENUM_MEMBER))
    ctx.glyphs.register(TS_KINDS.VARIABLE, getKindGlyph(TS_KINDS.VARIABLE))
    ctx.glyphs.register(TS_KINDS.PROPERTY, getKindGlyph(TS_KINDS.PROPERTY))
    ctx.glyphs.register(TS_KINDS.NAMESPACE, getKindGlyph(TS_KINDS.NAMESPACE))
    ctx.glyphs.register(TS_KINDS.EXPORT, getKindGlyph(TS_KINDS.EXPORT))

    registeredMatcherId = ctx.fileIndex.registerMatcher({
      id: MATCHER_ID,
      matches: (node) => isTsFilePath(node.attributes.path),
    })
    unregisterMatcher = () => {
      if (!registeredMatcherId) return
      ctx.fileIndex.unregisterMatcher(registeredMatcherId)
      registeredMatcherId = null
    }

    const parsedByFile = new Map<string, ParsedTsFile>()
    const openFilesBySession = new Map<string, string>()
    clearSessionData = () => {
      for (const sessionId of openFilesBySession.keys()) {
        ctx.graph.session.clear(sessionId)
      }
      ctx.graph.session.clear()
      openFilesBySession.clear()
      parsedByFile.clear()
    }
    let scopeMode: 'focused' | 'full' = 'focused'

    const getIndexedFiles = (): IndexedTsFile[] => {
      const matched = registeredMatcherId
        ? ctx.fileIndex.getMatches(registeredMatcherId)
        : ctx.graph
            .findNodes(({ attributes }) => Boolean(attributes.path))
            .map((node) => ({
              nodeKey: node.key,
              path: node.attributes.path ?? '',
              attributes: node.attributes,
            }))

      return matched
        .map((entry) => ({
          nodeKey: entry.nodeKey,
          path: normalizePath(entry.path),
        }))
        .filter((entry) => isTsFilePath(entry.path))
    }

    const parseFiles = async (files: IndexedTsFile[]) => {
      if (files.length === 0) return
      const readResults = await ctx.files.readFiles(files.map((file) => file.path))

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const readResult = readResults[index]
        if (!readResult || readResult.content === null) {
          parsedByFile.delete(file.nodeKey)
          continue
        }

        try {
          const parsed = await parseTsContent(ctx, file.nodeKey, file.path, readResult.content)
          if (parsed) {
            parsedByFile.set(file.nodeKey, parsed)
          } else {
            parsedByFile.delete(file.nodeKey)
          }
        } catch (error) {
          console.error('[TsAdapter] Failed to parse TypeScript file', { file, error })
          parsedByFile.delete(file.nodeKey)
        }
      }
    }

    const syncWorkspaceEntries = async (forceNodeKeys: ReadonlySet<string> = new Set()) => {
      const indexedFiles = getIndexedFiles()
      const knownKeys = new Set(indexedFiles.map((file) => file.nodeKey))
      for (const nodeKey of parsedByFile.keys()) {
        if (!knownKeys.has(nodeKey)) {
          parsedByFile.delete(nodeKey)
        }
      }

      const toParse = indexedFiles.filter(
        (file) => forceNodeKeys.has(file.nodeKey) || !parsedByFile.has(file.nodeKey),
      )
      await parseFiles(toParse)
      return indexedFiles
    }

    const buildIndex = async (forceNodeKeys: ReadonlySet<string> = new Set()) => {
      const indexedFiles = await syncWorkspaceEntries(forceNodeKeys)
      const entries = indexedFiles
        .map((file) => parsedByFile.get(file.nodeKey))
        .filter((entry): entry is ParsedTsFile => Boolean(entry))
      return buildWorkspaceIndex(indexedFiles, entries)
    }

    const injectFocusedFile = async (
      sessionId: string,
      fileNodeKey: string,
      index?: Awaited<ReturnType<typeof buildIndex>>,
    ) => {
      const workspaceIndex = index ?? (await buildIndex())
      const parsed = parsedByFile.get(fileNodeKey)
      if (!parsed) {
        ctx.graph.session.clear(sessionId)
        return
      }
      const payload = buildResolvedPayload(parsed, workspaceIndex)
      ctx.graph.session.inject({
        sessionId,
        nodes: payload.nodes,
        edges: payload.edges,
      })
    }

    const injectFullScope = async (index?: Awaited<ReturnType<typeof buildIndex>>) => {
      const workspaceIndex = index ?? (await buildIndex())
      const payload = mergeRenderPayloads(
        workspaceIndex.entries.map((entry) => buildResolvedPayload(entry, workspaceIndex)),
      )
      ctx.graph.session.inject({
        nodes: payload.nodes,
        edges: payload.edges,
      })
    }

    const refreshOpenSessions = async (
      fileNodeKey: string,
      index?: Awaited<ReturnType<typeof buildIndex>>,
    ) => {
      if (scopeMode === 'full') {
        await injectFullScope(index)
        return
      }
      for (const [sessionId, openNodeKey] of openFilesBySession.entries()) {
        if (openNodeKey === fileNodeKey) {
          await injectFocusedFile(sessionId, fileNodeKey, index)
        }
      }
    }

    const adapter = createTsAdapter(ctx, {
      resolveSymbolNode: async (nodeKey) => {
        const fileNode = findTsFileRoot(ctx, nodeKey)
        if (!fileNode?.attributes.path) return null

        await syncWorkspaceEntries(new Set([fileNode.key]))
        const entry = parsedByFile.get(fileNode.key)
        const symbol = entry?.symbolsByNodeKey.get(nodeKey)
        if (!entry || !symbol) return null

        return {
          fileNodeKey: fileNode.key,
          filePath: normalizePath(fileNode.attributes.path),
          entry,
          symbol,
        }
      },

      ensureWorkspaceIndex: async () => buildIndex(),

      commitMutation: async (fileNodeKey, filePath, nextContent) => {
        await ctx.files.writeFile(filePath, nextContent)
        const parsed = await parseTsContent(ctx, fileNodeKey, filePath, nextContent)
        if (parsed) parsedByFile.set(fileNodeKey, parsed)
        else parsedByFile.delete(fileNodeKey)

        const workspaceIndex = await buildIndex(new Set([fileNodeKey]))
        await refreshOpenSessions(fileNodeKey, workspaceIndex)
      },
    })

    ctx.hierarchy.registerAdapter({
      id: adapter.id,
      name: adapter.name,
      supportedChildKinds: adapter.supportedChildKinds,
      supportedParentKinds: adapter.supportedParentKinds,
      handlers: {
        onDelete: (deleteCtx) => {
          const node = ctx.graph.getNode(deleteCtx.nodeKey)
          if (!node) {
            return Promise.resolve({ success: false, error: 'Node not found' })
          }
          return adapter.applyDelete({
            nodeKey: deleteCtx.nodeKey,
            nodeAttributes: node.attributes,
            parentKey: ctx.graph.getParent(deleteCtx.nodeKey),
          })
        },
        onRename: (renameCtx) => {
          const node = ctx.graph.getNode(renameCtx.nodeKey)
          if (!node) {
            return Promise.resolve({ success: false, error: 'Node not found' })
          }
          return adapter.applyRename({
            nodeKey: renameCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentName: renameCtx.currentLabel,
            newName: renameCtx.newLabel,
          })
        },
      },
    })

    ctx.events.on('graph:plugin-scope', async ({ pluginId, scope }) => {
      if (pluginId !== ctx.manifest.name) return
      scopeMode = scope
      if (scope === 'full') {
        await injectFullScope()
      } else {
        ctx.graph.session.clear()
      }
    })

    ctx.events.on('file:opened', async ({ nodeKey, sessionId }) => {
      openFilesBySession.set(sessionId, nodeKey)
      await buildIndex(new Set([nodeKey]))
      if (scopeMode === 'full') {
        await injectFullScope()
      } else {
        await injectFocusedFile(sessionId, nodeKey)
      }
    })

    ctx.events.on('file:closed', ({ nodeKey, sessionId }) => {
      const previous = openFilesBySession.get(sessionId)
      if (previous !== nodeKey) return
      openFilesBySession.delete(sessionId)
      if (scopeMode === 'focused') {
        ctx.graph.session.clear(sessionId)
      }
    })

    ctx.events.on('file:changed', async ({ nodeKey, path }) => {
      if (!isTsFilePath(path)) return
      const workspaceIndex = await buildIndex(new Set([nodeKey]))
      await refreshOpenSessions(nodeKey, workspaceIndex)
    })

    ctx.events.on('plugins:activated', async () => {
      if (scopeMode === 'full') {
        await injectFullScope()
      }
    })

    ctx.events.on('graph:loaded', async () => {
      if (scopeMode === 'full') {
        await injectFullScope()
      }
    })
  },

  deactivate() {
    if (clearSessionData) {
      clearSessionData()
      clearSessionData = null
    }
    if (unregisterMatcher) {
      unregisterMatcher()
      unregisterMatcher = null
    }
  },
}

export default plugin
