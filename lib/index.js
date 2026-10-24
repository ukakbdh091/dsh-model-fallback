/**
 * dsh-model-fallback
 *
 * 在模型请求失败时，把当前会话切到预设的备用模型，并在同一步里自动重试，
 * 而不是让整轮对话直接报错结束。
 *
 * 默认只在“模型无响应”时切：超时、连接失败、服务端 5xx、空响应。
 * 额度、鉴权、参数这类“模型答了但答的是错误”的情况不切；需要的话用 codes 放开，
 * codes: ['*'] 等于任何失败都切。
 *
 * 只使用 DSH 的公开扩展点：
 *   - agent/request-error  waterfall：拿到失败码，决定“换模型 + 重试”。
 *   - agent/request        waterfall：让紧接着的那次重试真的打到备用模型。
 *   - agent/pre-step        ：进入下一步时撤掉一次性覆盖。
 *
 * 不修改内核、不包装 adapter、不碰 session 日志格式。
 *
 * @module dsh-model-fallback
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

export const name = 'model-fallback'

// 这些服务是插件工作的最低要求：
//   agents —— 从事件里拿到 agent（事件本身会带，但 registry 用来兜底）
//   llm    —— resolveCallConfig() 校验备用模型是否真的存在
export const inject = ['agents', 'llm']

// “模型无响应”：请求根本没拿到有效回复。额度/鉴权/参数错误不在其中——
// 那些是模型侧给了明确答复，换模型通常也没用，反而会把会话悄悄换走。
const UNRESPONSIVE_CODES = ['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']
const DEFAULT_CODES = UNRESPONSIVE_CODES

// 用户取消造成的终止不是“模型报错”，绝不能因此换模型。
const NEVER_SWITCH = new Set(['ABORTED', 'CANCELLED'])

function matchesCode(codes, code) {
  if (NEVER_SWITCH.has(code)) return false
  return codes.has('*') || codes.has(code)
}

export const Config = z.object({
  fallbacks: z.array(z.object({
    provider: z.string().description('provider route，例如 slate / workbuddy-ai'),
    model: z.string().description('provider 自己的 model id'),
    reasoningEffort: z.string().description('可选：备用模型使用的推理档位'),
  })).default([]).volatile().description('备用模型链：按顺序尝试，主模型不在链里时从第一个开始'),
  codes: z.array(z.string()).default([...DEFAULT_CODES])
    .description('触发切换的失败码；默认只在模型无响应时切（超时/断线/5xx/空响应），["*"] 表示任何失败都切'),
  file: z.string().default('')
    .description('可选的 JSON 配置路径；存在时它的 fallbacks/codes 覆盖上面的配置'),
})

/** 去掉空条目、去重、保持顺序。 */
function normalizeFallbacks(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    if (!provider || !model) continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const item = { provider, model }
    if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '') {
      item.reasoningEffort = raw.reasoningEffort
    }
    out.push(item)
  }
  return out
}

function defaultConfigFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'model-fallback.json')
}

function sameRoute(left, right) {
  return left.provider === right.provider && left.model === right.model
}

function label(route) {
  return `${route.provider}/${route.model}`
}

export function apply(ctx, config = {}) {
  // fallbacks 是 volatile 字段：设置页改它不会重挂插件，值会原地更新，
  // 所以这里只留引用，每次用的时候再取当前值。
  const fallbackSource = config.fallbacks

  function baseFallbacks() {
    const value = isVolatile(fallbackSource) ? fallbackSource.get() : fallbackSource
    return normalizeFallbacks(value)
  }
  const baseCodes = Array.isArray(config.codes) && config.codes.length > 0
    ? config.codes
    : DEFAULT_CODES
  const file = typeof config.file === 'string' && config.file !== ''
    ? config.file
    : defaultConfigFile()

  // 每个 agent 的一次性覆盖：只在“失败后紧接着的重试”里生效。
  const overrides = new Map()

  // 本步内已经试过（或正要去试）的模型：同一个 step 里每个备用模型只试一次，
  // 保证严格按设置页里的顺序从上往下走，也不会因为 header 还没刷新而原地打转。
  const attempted = new Map()

  // 启动时留一个很小的状态文件：确认插件真的被装配了，出问题也好查。
  try {
    fs.writeFileSync(
      path.join(path.dirname(file), 'model-fallback.status.json'),
      `${JSON.stringify({
        plugin: 'dsh-model-fallback',
        loadedAt: new Date().toISOString(),
        fallbacks: baseFallbacks().length,
        codes: [...readCodes()],
        pid: process.pid,
      }, null, 2)}\n`,
    )
  } catch {
    // 状态文件只是方便排查，写不了不影响插件本身。
  }

  /** 读 JSON 覆盖文件；读不到/格式坏就退回插件配置。 */
  function readFileConfig() {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
    if (Array.isArray(raw)) return { fallbacks: normalizeFallbacks(raw) }
    if (!raw || typeof raw !== 'object') return undefined
    const out = {}
    if (Array.isArray(raw.fallbacks)) {
      const normalized = normalizeFallbacks(raw.fallbacks)
      // 空数组视为“没配”，继续沿用 YAML 里的链——避免一个空文件
      // 悄悄把 profile 配置盖掉。
      if (normalized.length > 0) out.fallbacks = normalized
    }
    if (Array.isArray(raw.codes) && raw.codes.length > 0) out.codes = raw.codes
    return out
  }

  function readChain() {
    const override = readFileConfig()
    if (override?.fallbacks !== undefined) return override.fallbacks
    return baseFallbacks()
  }

  function readCodes() {
    const override = readFileConfig()
    if (override?.codes !== undefined) return new Set(override.codes)
    return new Set(baseCodes)
  }

  /** 当前这次失败属于哪个 provider/model。 */
  function currentRoute(agent, fallbackProvider) {
    try {
      const header = agent.session.requestHeader()
      const cfg = header?.config
      if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
        return { provider: cfg.provider, model: cfg.model }
      }
    } catch {
      // 没有 header（极早期失败）时退回 AgentOptions。
    }
    const options = agent.options ?? {}
    return {
      provider: typeof fallbackProvider === 'string' ? fallbackProvider : (options.provider ?? ''),
      model: options.model ?? '',
    }
  }

  function routeKey(route) {
    return `${route.provider}/${route.model}`
  }

  /**
   * 取“链里当前模型之后、第一个还没试过的”。
   * 当前模型不在链里时从头开始；已经在链尾就没有下一个。
   * 记下已试过的模型，是为了 header 还没刷新时也不会反复选中同一个备用模型。
   */
  function chooseFallback(chain, current, tried) {
    tried.add(routeKey(current))
    const index = chain.findIndex((item) => sameRoute(item, current))
    const start = index >= 0 ? index + 1 : 0
    for (let i = start; i < chain.length; i += 1) {
      if (!tried.has(routeKey(chain[i]))) return chain[i]
    }
    return undefined
  }

  function attemptedOf(agent) {
    let tried = attempted.get(agent)
    if (!tried) {
      tried = new Set()
      attempted.set(agent, tried)
    }
    return tried
  }

  /**
   * 把选择写进会话：优先走 sessionController 的正规入口（会同时更新
   * selection 和 model/selection 事件），拿不到就至少写事件，保证会话
   * 重开后仍然记得这次切换。
   */
  function installSelection(agent, selected) {
    try {
      const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      const commands = controller?.commands
      if (commands && typeof commands.selectForNextRequest === 'function') {
        commands.selectForNextRequest(agent, selected)
        return 'sessionController'
      }
    } catch (error) {
      ctx.logger?.warn?.(`model-fallback: selectForNextRequest 不可用，退回写事件：${String(error)}`)
    }
    try {
      agent.session.append('model/selection', selected)
      return 'event'
    } catch (error) {
      ctx.logger?.warn?.(`model-fallback: 写 model/selection 失败：${String(error)}`)
      return 'none'
    }
  }

  // 1) 失败时：能换就换，然后让 loop 在同一步重试。
  ctx.on('agent/request-error', async (payload, next) => {
    const { agent, failure, signal } = payload
    if (!agent || !failure || signal?.aborted) return next()
    if (!matchesCode(readCodes(), failure.code)) return next()

    const chain = readChain()
    if (chain.length === 0) return next()

    const current = currentRoute(agent, payload.provider)
    const tried = attemptedOf(agent)
    const target = chooseFallback(chain, current, tried)
    if (!target || sameRoute(target, current)) {
      ctx.logger?.warn?.(
        `model-fallback: ${label(current)} 失败（${failure.code}），但链里没有下一个备用模型`,
      )
      return next()
    }

    let resolved
    try {
      resolved = await ctx.llm.resolveCallConfig({
        provider: target.provider,
        model: target.model,
        ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
      })
    } catch (error) {
      ctx.logger?.warn?.(
        `model-fallback: 备用模型 ${label(target)} 不可用，保留原错误：${String(error)}`,
      )
      return next()
    }

    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }

    // 先登记一次性覆盖，再改会话选择——顺序反过来的话，重试的那一次
    // 请求可能在 selection 落盘前就开始组装。
    tried.add(routeKey(selected))
    overrides.set(agent, selected)
    const how = installSelection(agent, selected)
    ctx.logger?.warn?.(
      `model-fallback: ${failure.code} → ${label(current)} 切到 ${label(selected)}（via ${how}）`,
    )
    return { kind: 'retry' }
  })

  // 2) 重试时：把这一次请求真正改到备用模型上。
  //    必须 prepend + 在 next() 之后再改，才能盖过 installModelSelection
  //    用旧 assembled 值做的覆盖。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const selected = overrides.get(payload.agent)
    if (!selected) return resolved
    const { reasoningEffort: _inherited, ...withoutInherited } = resolved
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    }
  }, { prepend: true })

  // 3) 进入下一步时撤掉一次性覆盖；此时 selection 已经生效。
  ctx.on('agent/pre-step', (payload, next) => {
    overrides.delete(payload.agent)
    attempted.delete(payload.agent)
    return next()
  }, { prepend: true })

  // 4) 用户手动换模型时，不能让旧覆盖继续压着他。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'model/selection') return
    const data = event.data
    if (!data || typeof data.provider !== 'string' || typeof data.model !== 'string') return
    for (const [agent, selected] of overrides) {
      if (agent.session !== session) continue
      if (data.provider !== selected.provider || data.model !== selected.model) {
        overrides.delete(agent)
      }
    }
  })

  // 5) agent 被回收时别留着无用的覆盖。
  ctx.on('agent/disposed', ({ agent }) => {
    overrides.delete(agent)
    attempted.delete(agent)
  })

  ctx.logger?.info?.(
    `model-fallback: 已加载，备用链 ${baseFallbacks().length} 个，配置 ${file}`,
  )
}
