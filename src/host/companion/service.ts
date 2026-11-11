/**
 * CompanionService — the Vault-side owner of the shared persona.
 *
 * Published over Cordis as `companion` and consumed lazily by the QQ plugin
 * (`CordisCompanionProvider`). Only this class can write the three files; the
 * memory extraction engine has no reference to it, which is the guarantee
 * design §七 asks for.
 */
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { VAULT_DIRS } from '../../shared/types.js'
import { readTextIfExists, writeFileAtomic } from '../core/fsx.js'
import {
  COMPANION_FILES, DEFAULT_DOCUMENTS, documentsFromFiles, renderFiles,
  safeDocuments, validateDocuments, CompanionValidationError,
  type CompanionDocuments,
} from './documents.js'
import { DEFAULT_PRESET_ID, documentsFromPreset, findPreset, presetWire } from './presets.js'

export interface CompanionStatus {
  available: boolean
  usingDefault: boolean
  problems: string[]
  revision: string | null
}

export interface CompanionUpdate {
  name?: string
  identity?: string
  temperament?: string
  address?: string
  languageHabits?: string
  boundaries?: string[]
  /** Optional style anchors; omitted fields keep their current value. */
  scenario?: string
  catchphrases?: string[]
  avoid?: string[]
  examples?: { user: string; assistant: string }[]
  tone?: string
  notes?: string
  quietTriggers?: string[]
  stopTriggers?: string[]
}

export interface CompanionServiceOptions {
  now?: () => Date
  logger?: { warn: (message: string, ...rest: unknown[]) => void }
}

const digest = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)

export class CompanionService {
  private documents: CompanionDocuments = DEFAULT_DOCUMENTS
  private rev: string | null = null
  private usingDefault = true
  private problems: string[] = []
  private chain: Promise<unknown> = Promise.resolve()
  /** Guard against recursive self-heal when the vault is read-only. */
  private initializing = false
  private initFailed = false
  private readonly now: () => Date
  private readonly logger: CompanionServiceOptions['logger']

  constructor(
    private readonly getRoot: () => string | null,
    options: CompanionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
  }

  private paths(): { dir: string; persona: string; style: string; policy: string } | null {
    const root = this.getRoot()
    if (root === null || root.trim().length === 0) return null
    const dir = join(resolve(root), VAULT_DIRS.companion)
    return {
      dir,
      persona: join(dir, COMPANION_FILES.persona),
      style: join(dir, COMPANION_FILES.style),
      policy: join(dir, COMPANION_FILES.policy),
    }
  }

  /** Read the three files from disk. Never throws; never guesses a character. */
  async load(): Promise<CompanionDocuments> {
    const paths = this.paths()
    if (paths === null) {
      this.documents = DEFAULT_DOCUMENTS
      this.rev = null
      this.usingDefault = true
      this.problems = ['vault not ready']
      return this.documents
    }
    const problems: string[] = []
    const read = async (p: string): Promise<string | null> => {
      try { return await readTextIfExists(p) } catch (error) {
        problems.push(`read failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
    const [persona, style, policy] = await Promise.all([read(paths.persona), read(paths.style), read(paths.policy)])
    if (persona === null || style === null || policy === null) {
      // First run: materialise the default preset instead of showing "persona
      // file missing" forever on a brand-new vault. Only a *missing* file is
      // healed — a corrupt one keeps the conservative default and reports why,
      // because overwriting user text would be data loss.
      if (!this.initializing && !this.initFailed) {
        this.initializing = true
        try {
          await this.writeAll(paths, validateDocuments(documentsFromPreset(DEFAULT_PRESET_ID)))
          return await this.load()
        } catch (error) {
          this.initFailed = true
          this.logger?.warn(
            'dsh-longterm-memory: companion 初始化失败，继续使用保守默认: %s',
            error instanceof Error ? error.message : String(error),
          )
        } finally {
          this.initializing = false
        }
      }
      this.documents = DEFAULT_DOCUMENTS
      this.rev = null
      this.usingDefault = true
      this.problems = [...problems, 'companion files missing']
      return this.documents
    }
    const rev = digest([persona, style, policy])
    const checked = safeDocuments(documentsFromFiles({ persona, style, policy }, rev))
    this.documents = checked.documents
    this.rev = rev
    this.usingDefault = checked.problems.length > 0
    this.problems = [...problems, ...checked.problems]
    if (this.usingDefault) this.logger?.warn('dsh-longterm-memory: companion documents rejected: %s', this.problems.join('; '))
    return this.documents
  }

  /** Cordis contract: QQ plugin calls this to obtain the shared persona. */
  async getDocuments(): Promise<CompanionDocuments | null> {
    const paths = this.paths()
    if (paths === null) return null
    await this.load()
    return this.documents
  }

  /** Cordis contract: opaque revision for the QQ-side cache. */
  revision(): string | null {
    if (this.rev === null) void this.load()
    return this.rev ?? `${DEFAULT_DOCUMENTS.revision}:${this.now().toISOString().slice(0, 10)}`
  }

  status(): CompanionStatus {
    return {
      available: this.paths() !== null,
      usingDefault: this.usingDefault,
      problems: [...this.problems],
      revision: this.rev,
    }
  }

  /** Management UI only. Validates the merged result before any file is written. */
  async update(patch: CompanionUpdate): Promise<CompanionDocuments> {
    const paths = this.paths()
    if (paths === null) throw new CompanionValidationError(['vault not ready'])
    const current = await this.load()
    const merged = {
      persona: {
        name: patch.name ?? current.persona.name,
        identity: patch.identity ?? current.persona.identity,
        temperament: patch.temperament ?? current.persona.temperament,
        address: patch.address ?? current.persona.address,
        languageHabits: patch.languageHabits ?? current.persona.languageHabits,
        // Optional anchors keep their current value when the patch omits them,
        // so an older client that does not know about examples cannot wipe them.
        scenario: patch.scenario ?? current.persona.scenario,
        catchphrases: patch.catchphrases ?? current.persona.catchphrases,
        avoid: patch.avoid ?? current.persona.avoid,
        examples: patch.examples ?? current.persona.examples,
        boundaries: patch.boundaries ?? current.persona.boundaries,
      },
      style: { tone: patch.tone ?? current.style.tone, notes: patch.notes ?? current.style.notes },
      policy: {
        pretendHuman: false as const,
        emotionalDependency: false as const,
        quietTriggers: patch.quietTriggers ?? current.policy.quietTriggers,
        stopTriggers: patch.stopTriggers ?? current.policy.stopTriggers,
      },
      revision: 'pending',
    }
    const validated = validateDocuments(merged)
    const files = renderFiles(validated)
    const run = this.chain.catch(() => undefined).then(async () => {
      // All three validated before any write; atomic writes keep each file whole.
      await writeFileAtomic(paths.persona, files.persona)
      await writeFileAtomic(paths.style, files.style)
      await writeFileAtomic(paths.policy, files.policy)
    })
    this.chain = run
    await run
    const reloaded = await this.load()
    return reloaded
  }

  /** Write the built-in default files if none exist (management page "initialise"). */
  async ensureFiles(): Promise<CompanionDocuments> {
    const paths = this.paths()
    if (paths === null) throw new CompanionValidationError(['vault not ready'])
    if ((await readTextIfExists(paths.persona)) !== null) return this.load()
    return this.applyPreset(DEFAULT_PRESET_ID)
  }

  /** Hero list for the management page. Ids only — labels live in i18n. */
  presets(): { id: string; label: string; tagline: string }[] {
    return presetWire()
  }

  /**
   * Replace all three documents with a preset, then re-read from disk so the
   * caller sees exactly what the QQ side will see.
   *
   * Applying a preset is an explicit user action in the UI; there is no
   * "auto-apply on first launch" beyond {@link ensureFiles}.
   */
  async applyPreset(id: string): Promise<CompanionDocuments> {
    const paths = this.paths()
    if (paths === null) throw new CompanionValidationError(['vault not ready'])
    const preset = findPreset(id)
    if (preset === undefined) throw new CompanionValidationError([`unknown preset: ${id}`])
    const docs = validateDocuments(documentsFromPreset(preset.id))
    const run = this.chain.catch(() => undefined).then(() => this.writeAll(paths, docs))
    this.chain = run
    await run
    return this.load()
  }

  /**
   * Fill the *empty* style anchors from a preset, leaving everything the user
   * already wrote untouched.
   *
   * Needed because persona files written before the anchors existed have none
   * of them: without this the user's only options are "hand-write examples" or
   * "apply a preset and lose my edits".
   */
  async fillAnchors(id: string): Promise<CompanionDocuments> {
    const paths = this.paths()
    if (paths === null) throw new CompanionValidationError(['vault not ready'])
    const preset = findPreset(id)
    if (preset === undefined) throw new CompanionValidationError([`unknown preset: ${id}`])
    const current = await this.load()
    const merged = {
      persona: {
        ...current.persona,
        scenario: current.persona.scenario === '' ? preset.persona.scenario : current.persona.scenario,
        catchphrases: current.persona.catchphrases.length > 0
          ? current.persona.catchphrases : [...preset.persona.catchphrases],
        avoid: current.persona.avoid.length > 0 ? current.persona.avoid : [...preset.persona.avoid],
        examples: current.persona.examples.length > 0
          ? current.persona.examples
          : preset.persona.examples.map((example) => ({ ...example })),
      },
      style: current.style,
      policy: current.policy,
      revision: 'pending',
    }
    const validated = validateDocuments(merged)
    const run = this.chain.catch(() => undefined).then(() => this.writeAll(paths, validated))
    this.chain = run
    await run
    return this.load()
  }

  /** Atomic per-file writes; the caller has already validated the whole set. */
  private async writeAll(
    paths: { persona: string; style: string; policy: string },
    documents: CompanionDocuments,
  ): Promise<void> {
    const files = renderFiles(documents)
    await writeFileAtomic(paths.persona, files.persona)
    await writeFileAtomic(paths.style, files.style)
    await writeFileAtomic(paths.policy, files.policy)
  }
}
