import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'

let failures = 0
function check(label, cond, extra) {
  if (!cond) { failures += 1; console.log(`FAIL ${label}`, extra ?? '') }
  else console.log(`ok   ${label}`)
}

let seq = 0
function makeHarness(config) {
  const listeners = new Map()
  const on = (name, fn, options) => {
    const list = listeners.get(name) ?? []
    if (options?.prepend) list.unshift(fn)
    else list.push(fn)
    listeners.set(name, list)
    return () => {}
  }
  const appended = []
  const warnings = []
  const controller = {
    calls: [],
    commands: {
      selectForNextRequest(agent, selection) {
        controller.calls.push([agent, selection])
        agent.session.append('model/selection', selection)
      },
    },
  }
  const ctx = {
    on,
    get: (n) => (n === 'sessionController' ? controller : undefined),
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    llm: {
      async resolveCallConfig({ provider, model }) {
        if (model === 'missing') throw new Error('NO_ADAPTER')
        return { provider, model }
      },
    },
  }
  // 测试永远不读用户的 ~/.dsh/model-fallback.json，避免环境串味。
  apply(ctx, { file: join(tmpdir(), `dsh-fallback-missing-${++seq}.json`), ...config })
  const makeAgent = (name = 'deepseek-v4.1-flash', provider = 'slate') => ({
    session: {
      requestHeader: () => ({ config: { provider, model: name } }),
      append: (type, data) => { appended.push([type, data]); return { seq: appended.length } },
    },
    options: { provider, model: name },
  })
  async function waterfall(name, payload, seed) {
    const list = listeners.get(name) ?? []
    let i = 0
    const next = async () => (i < list.length ? list[i++](payload, next) : await seed())
    return next()
  }
  return { waterfall, makeAgent, controller, warnings, appended }
}

const chain = [
  { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' },
  { provider: 'slate', model: 'glm-5.3-flash' },
]

// 1. 默认只在“模型无响应”时切（超时/断线/5xx/空响应）
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('无响应默认切换', out?.kind === 'retry' && h.controller.calls.length === 1, out)
}

// 1b. 额度/限流这类“模型给了回复”的错误，默认不切
for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'AUTH', 'INVALID_REQUEST']) {
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code },
  }, async () => undefined)
  check(`${code} 默认不切换`, out === undefined && h.controller.calls.length === 0)
}

// 1c. codes: ['*'] 仍然可以放开成“任何失败都切”
{
  const h = makeHarness({ fallbacks: chain, codes: ['*'] })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'QUOTA' },
  }, async () => undefined)
  check("codes ['*'] 时额度错误也切", out?.kind === 'retry', out)
}


// 2. 用户取消不切
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'ABORTED' },
  }, async () => undefined)
  check('ABORTED 不切换', out === undefined && h.controller.calls.length === 0)
}

// 3. signal 已中止不切（哪怕失败码是普通的）
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'SERVER' }, signal: { aborted: true },
  }, async () => undefined)
  check('已中止的请求不切换', out === undefined && h.controller.calls.length === 0)
}

// 4. 用 codes 收窄后，非额度错误不切
{
  const h = makeHarness({ fallbacks: chain, codes: ['QUOTA', 'ACCOUNT_QUOTA'] })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'RATE_LIMIT' },
  }, async () => undefined)
  check('收窄 codes 后不切', out === undefined)
}

// 5. 主模型失败：切到链头并 retry
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('主模型失败返回 retry', out?.kind === 'retry', out)
  check('选择了链头', h.controller.calls.at(-1)?.[1]?.provider === 'workbuddy-ai')
}

// 6. 重试请求被改写到备用模型，且保留其它字段
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  const resolved = await h.waterfall('agent/request', { agent, turn: 1, step: 1 }, async () => ({
    provider: 'slate', model: 'deepseek-v4.1-flash', maxTokens: 100,
  }))
  check('重试请求改到备用模型', resolved.provider === 'workbuddy-ai' && resolved.model === 'deepseek-v4.1-flash', resolved)
  check('保留了其它请求字段', resolved.maxTokens === 100)
}

// 7. 备用模型 1 也失败：继续切到备用模型 2
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent('deepseek-v4.1-flash', 'workbuddy-ai')
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'workbuddy-ai', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('第二个备用模型也接管', out?.kind === 'retry' && h.controller.calls.at(-1)?.[1]?.provider === 'slate', out)
}

// 7b. 就算 header 还停在主模型上，第二次失败也要往后走，不能重复选第一个
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  const out = await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  const selected = h.controller.calls.at(-1)?.[1]
  check('第二次失败接着用下一个', out?.kind === 'retry' && selected?.model === 'glm-5.3-flash', selected)
}

// 7c. 进入下一个 step 后重新从链头开始
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  await h.waterfall('agent/pre-step', { agent, turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const out = await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  check('新 step 从链头重新开始', out?.kind === 'retry' && h.controller.calls.at(-1)?.[1]?.provider === 'workbuddy-ai', h.controller.calls.at(-1)?.[1])
}

// 8. 链尾也失败：不再 retry
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent('glm-5.3-flash')
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('链尾不再重试', out === undefined)
}

// 9. 备用模型不可用：不切换
{
  const h = makeHarness({ fallbacks: [{ provider: 'slate', model: 'missing' }] })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('备用模型不可用时不 retry', out === undefined)
}

// 10. 空链：什么都不做
{
  const h = makeHarness({ fallbacks: [] })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('空链不 retry', out === undefined)
}

// 11. 下一步开始后撤销覆盖
{
  const h = makeHarness({ fallbacks: chain })
  const agent = h.makeAgent()
  await h.waterfall('agent/request-error', { agent, provider: 'slate', failure: { code: 'TIMEOUT' } }, async () => undefined)
  await h.waterfall('agent/pre-step', { agent, turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const resolved = await h.waterfall('agent/request', { agent, turn: 1, step: 2 }, async () => ({
    provider: 'slate', model: 'deepseek-v4.1-flash',
  }))
  check('下一步不再强压备用模型', resolved.provider === 'slate')
}

// 12. JSON 文件覆盖 YAML 配置
{
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fallback-'))
  const file = join(dir, 'model-fallback.json')
  writeFileSync(file, JSON.stringify({
    fallbacks: [{ provider: 'slate', model: 'gpt-6-luna' }],
    codes: ['TIMEOUT'],
  }))
  const h = makeHarness({ fallbacks: chain, file })
  const agent = h.makeAgent()
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('JSON 文件覆盖生效', out?.kind === 'retry' && h.controller.calls.at(-1)?.[1]?.model === 'gpt-6-luna', out)
  rmSync(dir, { recursive: true, force: true })
}

// 13. 设置页写的是 volatile 字段：值能原地更新，不用重挂插件
{
  check('fallbacks schema 标记为 volatile', Config.dict.fallbacks.meta.volatile === true)
  const live = createVolatile([{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' }])
  check('createVolatile 生效', isVolatile(live) === true)
  const h = makeHarness({ fallbacks: live })
  const agent = h.makeAgent()
  updateVolatile(live, createVolatile([{ provider: 'slate', model: 'gpt-6-luna' }]))
  const out = await h.waterfall('agent/request-error', {
    agent, provider: 'slate', failure: { code: 'TIMEOUT' },
  }, async () => undefined)
  check('volatile 链被实时读到', out?.kind === 'retry' && h.controller.calls.at(-1)?.[1]?.model === 'gpt-6-luna', out)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
