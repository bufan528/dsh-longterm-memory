/**
 * The real DSH model adapter for memory extraction.
 *
 * This is the only place in the plugin that talks to a model, and it is inert
 * until the user turns `enableLlmExtraction` on: the call goes through the user's
 * own configured provider, so it costs money and sends the turn's text to that
 * provider. Both facts are surfaced in the management page.
 *
 * Two deliberate choices:
 *
 * - **No static `@deepseek-ai/*` import.** `@deepseek-ai/dsh-llm` is reached with
 *   a guarded dynamic import, so an installation where it does not resolve simply
 *   reports the feature unavailable instead of failing plugin activation.
 * - **No `BlockAssembler`.** The assembled text is all this feature needs, so the
 *   chunks are collected with a tolerant reader that understands both documented
 *   stream shapes. An unrecognised chunk shape yields no text, which is treated as
 *   a failed extraction rather than being guessed at.
 *
 * @module dsh-longterm-memory/host/dsh/llm
 */

import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserText,
  type LlmAdapter,
  type LlmExtractionAnswer,
  type LlmExtractionRequest,
} from '../core/llm-extraction.js'

/** The `ctx.llm` surface this adapter uses. */
interface LlmServiceLike {
  prepareCall: (
    config: { provider: string; model: string; maxTokens?: number },
    signal: AbortSignal | undefined,
    configure?: (controls: Record<string, unknown>, model: unknown) => Record<string, unknown>,
  ) => Promise<{
    config: Record<string, unknown>
    stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
  }>
}

/** The `ctx.agentDefaultModel` surface this adapter uses. */
interface DefaultModelLike {
  currentSelection: () => { provider: string; model: string; reasoningEffort?: unknown }
}

interface CordisLike {
  get: (name: string) => unknown
  logger?: { info: (message: string, ...rest: unknown[]) => void; warn: (message: string, ...rest: unknown[]) => void }
}

/** `createUserMessage` exactly as `@deepseek-ai/dsh-llm` exports it. */
type CreateUserMessage = (input: Record<string, unknown>) => unknown

export interface DshLlmAdapterOptions {
  /** End-to-end budget for one extraction call. */
  timeoutMs: number
  /** Output-token cap. */
  maxOutputTokens: number
}

export interface DshLlmAdapter extends LlmAdapter {
  /** Resolve the module and services once; safe to call more than once. */
  init: () => Promise<void>
}

/**
 * Collect assistant text from a stream of chunks.
 *
 * The two documented shapes are a `text-chunks` record carrying `texts`, and a
 * `text-delta` chunk (either top level or nested under `chunk`). Anything else is
 * ignored: a shape this reader does not understand must not be silently
 * reinterpreted, because the result is fed to a policy that decides what becomes
 * a long-term memory.
 */
export function collectAssistantText(chunks: readonly unknown[]): string {
  const parts: string[] = []
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      parts.push(chunk)
      continue
    }
    if (chunk === null || typeof chunk !== 'object') continue
    const record = chunk as Record<string, unknown>
    if (record['type'] === 'text-chunks' && Array.isArray(record['texts'])) {
      parts.push(record['texts'].filter((text): text is string => typeof text === 'string').join(''))
      continue
    }
    if (record['type'] === 'text-delta' && typeof record['text'] === 'string') {
      parts.push(record['text'])
      continue
    }
    const nested = record['chunk']
    if (nested !== null && typeof nested === 'object') {
      const inner = nested as Record<string, unknown>
      if (inner['type'] === 'text-delta' && typeof inner['text'] === 'string') parts.push(inner['text'])
    }
  }
  return parts.join('')
}

/** Build the adapter bound to one Cordis context. */
export function createDshLlmAdapter(ctx: CordisLike, options: DshLlmAdapterOptions): DshLlmAdapter {
  let createUserMessage: CreateUserMessage | undefined
  let reason: string | undefined = '模型访问尚未初始化'
  let initialised = false
  let initPromise: Promise<void> | undefined

  const init = async (): Promise<void> => {
    if (initPromise !== undefined) return initPromise
    initPromise = (async () => {
      try {
        // A variable specifier keeps this out of static analysis, so a build does
        // not hard-require a package this plugin does not depend on.
        const moduleName = '@deepseek-ai/dsh-llm'
        const loaded = (await import(/* @vite-ignore */ moduleName)) as { createUserMessage?: CreateUserMessage }
        if (typeof loaded.createUserMessage !== 'function') {
          reason = '无法从 @deepseek-ai/dsh-llm 取得 createUserMessage'
          return
        }
        createUserMessage = loaded.createUserMessage
        if (ctx.get('llm') === undefined) {
          reason = '宿主未提供 ctx.llm'
          return
        }
        if (ctx.get('agentDefaultModel') === undefined) {
          reason = '宿主未提供 ctx.agentDefaultModel，无法确定模型路由'
          return
        }
        reason = undefined
      } catch (error) {
        reason = `无法加载 @deepseek-ai/dsh-llm：${describeError(error)}`
      } finally {
        initialised = true
      }
    })()
    return initPromise
  }

  return {
    get available(): boolean {
      return initialised && createUserMessage !== undefined && reason === undefined
    },
    get reason(): string | undefined {
      return reason
    },
    init,

    async complete(request: LlmExtractionRequest, signal: AbortSignal): Promise<LlmExtractionAnswer> {
      if (createUserMessage === undefined) throw new Error(reason ?? '模型访问不可用')
      const llm = ctx.get('llm') as LlmServiceLike | undefined
      if (llm === undefined) throw new Error('宿主未提供 ctx.llm')
      const defaultModel = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
      if (defaultModel === undefined) throw new Error('宿主未提供 ctx.agentDefaultModel')

      const selection = defaultModel.currentSelection()
      if (typeof selection.provider !== 'string' || selection.provider.length === 0) {
        throw new Error('当前没有可用的默认模型 provider')
      }
      if (typeof selection.model !== 'string' || selection.model.length === 0) {
        throw new Error('当前没有可用的默认模型')
      }

      // Own timeout so a slow provider cannot hold the extraction chain open.
      const controller = new AbortController()
      const abortFromParent = (): void => controller.abort(signal.reason)
      if (signal.aborted) abortFromParent()
      else signal.addEventListener('abort', abortFromParent, { once: true })
      const timer = setTimeout(() => {
        controller.abort(new Error(`记忆提取调用超时（${String(options.timeoutMs)} ms）`))
      }, options.timeoutMs)

      try {
        const call = await llm.prepareCall(
          { provider: selection.provider, model: selection.model, maxTokens: options.maxOutputTokens },
          controller.signal,
          (controls) => controls,
        )
        const message = createUserMessage({
          content: [{ type: 'text', text: buildExtractionUserText(request) }],
          source: { kind: 'dsh-longterm-memory', form: 'extraction' },
        })
        const streamOptions: Record<string, unknown> = {
          ...call.config,
          messages: [message],
          system: EXTRACTION_SYSTEM_PROMPT,
          signal: controller.signal,
        }

        const chunks: unknown[] = []
        for await (const chunk of call.stream(streamOptions)) {
          if (controller.signal.aborted) break
          chunks.push(chunk)
        }
        if (controller.signal.aborted) {
          throw new Error(`记忆提取调用被中止：${describeError(controller.signal.reason)}`)
        }
        const text = collectAssistantText(chunks)
        if (text.trim().length === 0) {
          throw new Error('模型没有返回任何文本，已按提取失败处理')
        }
        return { text, provider: selection.provider, model: selection.model }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abortFromParent)
      }
    },
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
