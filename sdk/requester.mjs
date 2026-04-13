/**
 * SavantDex Requester SDK
 *
 * Adaptation layer that exposes A2A-aligned semantics on top of the
 * Streamr P2P transport. Internal protocol is unchanged.
 *
 * Public API:
 *   const r = await SavantDexRequester.create(config)
 *
 *   // Discovery
 *   const agents = await r.findAgents({ capability, category, q,
 *                                        supportsAsync, maxExpectedLatencyMs })
 *   const card   = await r.getCard(agentId)   // A2A-style agent card
 *
 *   // Invocation — returns TaskResult
 *   const result = await r.run(agentId, input, { timeout })
 *   // result = { taskId, status: 'completed'|'failed', output, meta }
 *   // meta  = { durationMs, agentId, streamId, taskType }
 *
 *   await r.destroy()
 *
 * config:
 *   privateKey     string  — Ethereum private key (requester identity)
 *   agentId        string  — unique name for this requester, e.g. "my-bot-v1"
 *   registryUrl    string  — default "http://localhost:3000"
 *   network        object  — { websocketPort, externalIp } (optional for Streamr P2P)
 */

import { SavantDex } from './index.mjs'

export class SavantDexRequester {
  #agent
  #registryUrl

  constructor(agent, registryUrl) {
    this.#agent = agent
    this.#registryUrl = registryUrl
  }

  /**
   * Create and initialize a requester agent.
   * Registers an inbox stream on Streamr (one-time, ~0.01 POL gas).
   *
   * @param {object} config
   * @param {string}  [config.registryUrl]
   * @param {boolean} [config.skipRegister=false]
   *   Skip the register() check. Use when the inbox stream already exists and
   *   all participants share the same owner key (owner can always publish to
   *   their own streams without needing public PUBLISH permission).
   */
  static async create(config) {
    const { registryUrl = 'http://localhost:3000', skipRegister = false, ...agentConfig } = config
    const agent = new SavantDex(agentConfig)
    if (!skipRegister) {
      await agent.register()
    }
    return new SavantDexRequester(agent, registryUrl)
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  /**
   * Find agents matching filters. Returns registry records with callHint.
   *
   * @param {object} filters
   * @param {string}  [filters.capability]
   * @param {string}  [filters.category]
   * @param {string}  [filters.q]                 keyword search
   * @param {boolean} [filters.supportsAsync]
   * @param {number}  [filters.maxExpectedLatencyMs]
   * @returns {Promise<Array>} agent records, each with .callHint
   */
  async findAgents(filters = {}) {
    const params = new URLSearchParams()
    if (filters.capability != null)            params.set('capability', filters.capability)
    if (filters.category != null)              params.set('category', filters.category)
    if (filters.q != null)                     params.set('q', filters.q)
    if (filters.supportsAsync != null)         params.set('supportsAsync', String(filters.supportsAsync))
    if (filters.maxExpectedLatencyMs != null)  params.set('maxExpectedLatencyMs', String(filters.maxExpectedLatencyMs))

    const qs  = params.toString()
    const url = `${this.#registryUrl}/agents${qs ? '?' + qs : ''}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Registry error ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.agents
  }

  /**
   * Get the standardized A2A-style agent card for a specific agent.
   * @param {string} agentId
   * @returns {Promise<object>} agent card (savantdex/card/1.0)
   */
  async getCard(agentId) {
    const res = await fetch(`${this.#registryUrl}/agents/${encodeURIComponent(agentId)}/card`)
    if (!res.ok) throw new Error(`Agent not found: ${agentId}`)
    return res.json()
  }

  // ── Invocation ─────────────────────────────────────────────────────────────

  /**
   * Run a task on a remote agent and wait for the result.
   *
   * Task lifecycle: submitted → running → completed | failed
   *
   * @param {string|object} agentIdOrRecord  agentId string, or registry record with callHint
   * @param {object}        input            task input matching agent's inputSchema
   * @param {object}        [opts]
   * @param {number}        [opts.timeout=30000]  ms to wait for result
   * @returns {Promise<TaskResult>}
   *
   * TaskResult = {
   *   taskId:  string,
   *   status:  'completed' | 'failed',
   *   output:  object,            // agent's response
   *   error:   string | null,     // set on 'failed'
   *   meta: {
   *     durationMs: number,
   *     agentId:    string,
   *     streamId:   string,
   *     taskType:   string | null,
   *   }
   * }
   */
  async run(agentIdOrRecord, input, opts = {}) {
    const { timeout = 30000 } = opts
    const { streamId, taskType, agentId } = await this.#resolveInvocation(agentIdOrRecord)

    if (!taskType) {
      throw new Error(`Agent "${agentId}" has no taskType registered — cannot determine task envelope type`)
    }

    const startMs = Date.now()

    // status: submitted
    const taskId = await this.#agent.sendTask(streamId, { type: taskType, input })

    // status: running → completed | failed
    try {
      const output = await this.#agent.waitForResult(taskId, timeout, streamId.split('/')[0])
      return {
        taskId,
        status:  'completed',
        output,
        error:   null,
        meta: {
          durationMs: Date.now() - startMs,
          agentId,
          streamId,
          taskType,
        },
      }
    } catch (err) {
      return {
        taskId,
        status:  'failed',
        output:  null,
        error:   err.message,
        meta: {
          durationMs: Date.now() - startMs,
          agentId,
          streamId,
          taskType,
        },
      }
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async #resolveInvocation(agentIdOrRecord) {
    if (typeof agentIdOrRecord === 'string') {
      const res = await fetch(`${this.#registryUrl}/agents/${encodeURIComponent(agentIdOrRecord)}`)
      if (!res.ok) throw new Error(`Agent not found: ${agentIdOrRecord}`)
      const record = await res.json()
      return {
        streamId: record.callHint?.streamId || record.streamId,
        taskType: record.callHint?.taskType || null,
        agentId:  agentIdOrRecord,
      }
    }

    // Already a registry record with callHint
    return {
      streamId: agentIdOrRecord.callHint?.streamId || agentIdOrRecord.streamId,
      taskType: agentIdOrRecord.callHint?.taskType || null,
      agentId:  agentIdOrRecord.agentId,
    }
  }

  async destroy() {
    await this.#agent.destroy()
  }
}
