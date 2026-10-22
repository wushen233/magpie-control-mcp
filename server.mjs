#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'

const SERVER_NAME = 'magpie-control'
const SERVER_VERSION = '0.1.0'
const MAGPIE_BIN = process.env.MAGPIE_BIN || 'magpie-windows-amd64.exe'
const GATEWAY_URL = (process.env.MAGPIE_GATEWAY_URL || 'http://127.0.0.1:3425').replace(/\/$/, '')
const GATEWAY_KEY = process.env.MAGPIE_GATEWAY_KEY || 'magpie'
const COMMAND_TIMEOUT_MS = 45_000
const PROBE_TIMEOUT_MS = 90_000
const MAX_STDIO_BYTES = 2 * 1024 * 1024
const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])

const tools = [
  {
    name: 'magpie_status',
    description: 'Read Magpie version, routing groups, and quota snapshot. Read-only; quota may refresh provider usage according to Magpie behavior.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'magpie_models',
    description: 'List models currently exposed by Magpie. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'magpie_groups',
    description: 'List current Magpie routing groups. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'magpie_group_show',
    description: 'Show one current Magpie routing group by ID or name. Read-only.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'magpie_provider_test',
    description: 'Ask Magpie to send its small provider test request and report reachability/latency. This consumes a small provider request; call only when the user asked to test availability or speed.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', minLength: 1 } }, required: ['provider'], additionalProperties: false },
  },
  {
    name: 'magpie_model_probe',
    description: 'Send one tiny request through the local Magpie gateway to test a listed model. Reports success, elapsed time, and token usage; it is not a quality score and consumes model quota. Call only when the user asked to test this model.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', minLength: 1 } }, required: ['model'], additionalProperties: false },
  },
  {
    name: 'magpie_group_create',
    description: 'Create a routing group from models already exposed by Magpie. This changes shared Magpie configuration. Use only when the user explicitly requested creating this group. Never reuse a group ID that already exists.',
    inputSchema: {
      type: 'object', properties: {
        name: { type: 'string', minLength: 1 },
        models: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        routing: { type: 'string', enum: ['smart', 'order', 'rotate', 'usage', 'pace', 'weight'] },
        stays: { type: 'string', enum: ['auto', 'session', 'turn', 'off', 'strict'] },
      }, required: ['name', 'models'], additionalProperties: false,
    },
  },
  {
    name: 'magpie_group_update',
    description: 'Update an existing Magpie routing group by adding/removing models or changing routing/stays. This changes shared configuration; use only when the user explicitly requested the change. Model IDs must already be exposed by Magpie.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', minLength: 1 },
        addModels: { type: 'array', items: { type: 'string', minLength: 1 } },
        removeModels: { type: 'array', items: { type: 'string', minLength: 1 } },
        routing: { type: 'string', enum: ['smart', 'order', 'rotate', 'usage', 'pace', 'weight'] },
        stays: { type: 'string', enum: ['auto', 'session', 'turn', 'off', 'strict'] },
      }, required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'magpie_group_remove',
    description: 'Remove or hide a Magpie routing group. This changes shared Magpie configuration and can break agents using that group. Use only when the user explicitly requested removing this exact group.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  },
]

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  writeMessage({ jsonrpc: '2.0', id, error })
}

function resultText(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

function assertObject(value, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function requiredString(value, key) {
  if (typeof value?.[key] !== 'string' || !value[key].trim()) throw new Error(`${key} is required`)
  return value[key].trim()
}

function safeCliArg(value, label) {
  const result = String(value).trim()
  if (!result || result.startsWith('-') || /[\0\r\n]/.test(result)) throw new Error(`${label} is empty or contains unsupported characters`)
  return result
}

async function getModelCatalog() {
  const response = await fetch(`${GATEWAY_URL}/v1/models`, {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Magpie model catalog returned HTTP ${response.status}`)
  const body = await response.json()
  const ids = new Set((Array.isArray(body?.data) ? body.data : []).map(entry => entry?.id).filter(id => typeof id === 'string'))
  if (ids.size === 0) throw new Error('Magpie returned an empty or unrecognized model catalog')
  return { ids, body }
}

function validateModelIds(models) {
  if (!Array.isArray(models) || models.length === 0 || models.some(model => typeof model !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/+-]+$/.test(model.trim()))) {
    throw new Error('models must be a non-empty array of provider/model IDs')
  }
  return [...new Set(models.map(model => model.trim()))]
}

function parseGroupIds(output) {
  const ids = new Set()
  for (const match of output.matchAll(/\bgroup\/([A-Za-z0-9._-]+)/g)) ids.add(match[1].toLowerCase())
  return ids
}

async function runMagpie(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(MAGPIE_BIN, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const collect = (target, chunk, stream) => {
      bytes += chunk.length
      if (bytes > MAX_STDIO_BYTES) {
        child.kill()
        finish(new Error('Magpie command output exceeded the 2 MiB safety limit'))
        return
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', chunk => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', chunk => collect(stderr, chunk, 'stderr'))
    child.once('error', error => finish(new Error(`Unable to start Magpie CLI (${MAGPIE_BIN}): ${error.message}`)))
    child.once('close', code => {
      if (code !== 0) finish(new Error(`Magpie exited with code ${code}: ${(stderr || stdout).trim() || 'no diagnostic output'}`))
      else finish(null, { stdout: stdout.trim(), stderr: stderr.trim() })
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Magpie CLI timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
}

async function requireListedModels(models) {
  const normalized = validateModelIds(models)
  const { ids: available } = await getModelCatalog()
  const unknown = normalized.filter(model => !available.has(model))
  if (unknown.length) throw new Error(`These model IDs are not currently listed by Magpie: ${unknown.join(', ')}`)
  return normalized
}

function groupIdFromName(name) {
  return name.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

async function callGatewayModel(model) {
  const started = performance.now()
  const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: MAGPIE_PROBE_OK' }],
      max_tokens: 16,
      stream: false,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const elapsedMs = Math.round(performance.now() - started)
  const raw = await response.text()
  let body
  try { body = JSON.parse(raw) } catch { body = { raw: raw.slice(0, 2000) } }
  if (!response.ok) throw new Error(`Magpie gateway returned HTTP ${response.status}: ${JSON.stringify(body)}`)
  return {
    ok: true,
    model,
    elapsedMs,
    response: body?.choices?.[0]?.message?.content ?? body?.output?.[0]?.content?.[0]?.text ?? null,
    usage: body?.usage ?? null,
  }
}

function validateGroupOptions(args) {
  if (args.routing !== undefined && !['smart', 'order', 'rotate', 'usage', 'pace', 'weight'].includes(args.routing)) {
    throw new Error('routing must be one of smart, order, rotate, usage, pace, or weight')
  }
  if (args.stays !== undefined && !['auto', 'session', 'turn', 'off', 'strict'].includes(args.stays)) {
    throw new Error('stays must be one of auto, session, turn, off, or strict')
  }
}

async function callTool(name, rawArgs) {
  const args = assertObject(rawArgs ?? {})
  switch (name) {
    case 'magpie_status': {
      const [version, groups, quota] = await Promise.all([
        runMagpie(['--version']), runMagpie(['groups']), runMagpie(['quota', '--json']),
      ])
      return { version: version.stdout, groups: groups.stdout, quota: quota.stdout }
    }
    case 'magpie_models':
      return (await getModelCatalog()).body
    case 'magpie_groups':
      return (await runMagpie(['groups'])).stdout
    case 'magpie_group_show': {
      const id = safeCliArg(requiredString(args, 'id'), 'id')
      return (await runMagpie(['group', id])).stdout
    }
    case 'magpie_provider_test': {
      const provider = safeCliArg(requiredString(args, 'provider'), 'provider')
      return (await runMagpie(['provider', 'test', provider], PROBE_TIMEOUT_MS)).stdout
    }
    case 'magpie_model_probe': {
      const model = safeCliArg(requiredString(args, 'model'), 'model')
      const { ids: available } = await getModelCatalog()
      if (!available.has(model)) throw new Error(`Model is not currently listed by Magpie: ${model}`)
      return callGatewayModel(model)
    }
    case 'magpie_group_create': {
      const name = requiredString(args, 'name')
      const safeName = safeCliArg(name, 'name')
      const models = await requireListedModels(args.models)
      validateGroupOptions(args)
      const groupListing = (await runMagpie(['groups'])).stdout
      const ids = parseGroupIds(groupListing)
      const candidateId = groupIdFromName(name)
      if (!candidateId) throw new Error('Group name does not produce a valid ID')
      const duplicateName = groupListing.split(/\r?\n/).some(line => {
        const current = line.trimStart().toLocaleLowerCase()
        const sought = name.toLocaleLowerCase()
        return current === sought || current.startsWith(`${sought} `) || current.startsWith(`${sought}\t`)
      })
      if (ids.has(candidateId) || duplicateName) throw new Error(`A routing group with this ID or name already exists: ${candidateId}`)
      const cliArgs = ['group', 'add', safeName, `models=${models.join(',')}`]
      if (args.routing) cliArgs.push(`routing=${args.routing}`)
      if (args.stays) cliArgs.push(`stays=${args.stays}`)
      return (await runMagpie(cliArgs)).stdout || `Created group ${candidateId}`
    }
    case 'magpie_group_update': {
      const id = safeCliArg(requiredString(args, 'id'), 'id')
      validateGroupOptions(args)
      await runMagpie(['group', id])
      const cliArgs = ['group', 'set', id]
      let changed = false
      if (args.addModels !== undefined) {
        const models = await requireListedModels(args.addModels)
        cliArgs.push(`models+=${models.join(',')}`)
        changed = true
      }
      if (args.removeModels !== undefined) {
        const models = validateModelIds(args.removeModels)
        cliArgs.push(`models-=${models.join(',')}`)
        changed = true
      }
      if (args.routing !== undefined) { cliArgs.push(`routing=${args.routing}`); changed = true }
      if (args.stays !== undefined) { cliArgs.push(`stays=${args.stays}`); changed = true }
      if (!changed) throw new Error('Provide addModels, removeModels, routing, or stays')
      return (await runMagpie(cliArgs)).stdout || `Updated group ${id}`
    }
    case 'magpie_group_remove': {
      const id = safeCliArg(requiredString(args, 'id'), 'id')
      await runMagpie(['group', id])
      return (await runMagpie(['group', 'rm', id])).stdout || `Removed or hid group ${id}`
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) rpcError(message.id, -32600, 'Invalid Request')
    return
  }
  if (message.id === undefined) return // Notifications have no response.
  const { id, method, params = {} } = message
  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion
        const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18'
        writeMessage({ jsonrpc: '2.0', id, result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Magpie management tools operate on the local Magpie installation. Probe tools consume provider/model quota. Routing mutations change shared Magpie configuration and should be used only when the user asked for the exact change.',
        } })
        return
      }
      case 'ping':
        writeMessage({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        writeMessage({ jsonrpc: '2.0', id, result: { tools } })
        return
      case 'tools/call': {
        const toolName = requiredString(params, 'name')
        const known = tools.some(tool => tool.name === toolName)
        if (!known) { rpcError(id, -32602, `Unknown tool: ${toolName}`); return }
        try {
          const value = await callTool(toolName, params.arguments)
          writeMessage({ jsonrpc: '2.0', id, result: resultText(value) })
        } catch (error) {
          writeMessage({ jsonrpc: '2.0', id, result: resultText(error.message || String(error), true) })
        }
        return
      }
      default:
        rpcError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    rpcError(id, -32603, error.message || String(error))
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (!line.trim()) continue
  let message
  try { message = JSON.parse(line) } catch {
    rpcError(null, -32700, 'Parse error')
    continue
  }
  await handleRequest(message)
}
