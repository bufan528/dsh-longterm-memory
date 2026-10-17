/**
 * Vault layout: every path the plugin owns, in one place.
 *
 * @module dsh-longterm-memory/host/core/layout
 */

import { join } from 'node:path'
import { TYPE_DESCRIPTORS, VAULT_DIRS, type MemoryStatus, type MemoryType, typeDir } from '../../shared/types.js'
import { slugify } from '../../shared/markdown.js'

/** Identity written into the vault marker so we never adopt a foreign directory. */
export const VAULT_PRODUCT = 'dsh-longterm-memory'
export const VAULT_SCHEMA_VERSION = 1

/** Directory the plugin fully owns and may recreate at any time. */
export const PRIVATE_DIR = '.dsh-memory'

export interface VaultLayout {
  root: string
  marker: string
  config: string
  index: string
  journalDir: string
  historyDir: string
  quarantineDir: string
  readme: string
  home: string
  indexDir: string
  obsidianDir: string
}

export function layoutFor(root: string): VaultLayout {
  const privateDir = join(root, PRIVATE_DIR)
  return {
    root,
    marker: join(privateDir, 'config.json'),
    config: join(privateDir, 'config.json'),
    index: join(privateDir, 'index.json'),
    journalDir: join(privateDir, 'journal'),
    historyDir: join(root, VAULT_DIRS.history),
    quarantineDir: join(privateDir, 'quarantine'),
    readme: join(root, 'README.md'),
    home: join(root, 'Memory Home.md'),
    indexDir: join(root, VAULT_DIRS.index),
    obsidianDir: join(root, VAULT_DIRS.obsidian),
  }
}

/** All directories a fresh vault must contain, in creation order. */
export function requiredDirectories(layout: VaultLayout): string[] {
  const dirs = new Set<string>([
    layout.root,
    layout.indexDir,
    layout.historyDir,
    join(layout.root, VAULT_DIRS.inbox),
    join(layout.root, VAULT_DIRS.archive),
    join(layout.root, VAULT_DIRS.conflicts),
    layout.obsidianDir,
    join(layout.root, PRIVATE_DIR),
    layout.journalDir,
    layout.quarantineDir,
  ])
  for (const descriptor of Object.values(TYPE_DESCRIPTORS)) dirs.add(join(layout.root, descriptor.dir))
  return [...dirs]
}

/** Vault-relative directory for a memory, honouring its status. */
export function directoryFor(type: MemoryType, status: MemoryStatus): string {
  return typeDir(type, status)
}

/**
 * Vault-relative path for a memory note.
 *
 * @param fileName - the complete file name, extension included (see
 *   `memoryFileName`); a collision with an existing note gains a `-2` suffix
 *   before the extension rather than after it.
 */
export function relativePathFor(
  type: MemoryType,
  status: MemoryStatus,
  fileName: string,
  taken = new Set<string>(),
): string {
  const dir = directoryFor(type, status)
  const match = /^(.*?)(\.md)?$/i.exec(fileName)
  const base = match?.[1] !== undefined && match[1].length > 0 ? match[1] : fileName
  const extension = match?.[2] ?? '.md'
  let stem = base
  let attempt = 1
  while (taken.has(`${dir}/${stem}${extension}`.toLowerCase())) {
    attempt += 1
    stem = `${base}-${String(attempt)}`
  }
  return `${dir}/${stem}${extension}`
}

/** Path of the human-readable index note for one category. */
export function indexNotePath(category: MemoryType | 'all'): string {
  const name = category === 'all' ? 'all-memories' : slugify(category)
  return `${VAULT_DIRS.index}/${name}.md`
}

export function journalPath(layout: VaultLayout, at: Date): string {
  const month = at.toISOString().slice(0, 7)
  return join(layout.journalDir, `${month}.jsonl`)
}
