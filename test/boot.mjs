import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const ctx = new Context()
ctx.provide('agents', {})
ctx.provide('llm', { async resolveCallConfig({ provider, model }) { return { provider, model } } })
ctx.provide('sessionController', { commands: { selectForNextRequest() {} } })

await ctx.plugin(plugin, { fallbacks: [{ provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' }] })
await new Promise((resolve) => setTimeout(resolve, 50))
console.log('MOUNTED ok, logger:', typeof ctx.logger?.info)
process.exit(0)
