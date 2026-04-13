/**
 * SavantDex SDK v0.3
 * Decentralized AI agent marketplace on Streamr Network
 */

import { StreamrClient, StreamPermission } from '@streamr/sdk'
import { randomBytes } from 'crypto'

export class SavantDex {
  #client
  #streamId
  #agentId
  #address
  #trustedTaskPublishers
  #pendingResults
  #resultSubscription
  #seenTaskIds
  #seenResultTaskIds

  /**
   * @param {object} config
   * @param {string} [config.privateKey]  - Ethereum private key (mutually exclusive with identity)
   * @param {object} [config.identity]    - Streamr Identity instance, e.g. RemoteSignerIdentity
   * @param {string} config.agentId       - Unique agent identifier (e.g. "wallet-analyst-v1")
   * @param {object} [config.network]     - Optional Streamr network overrides
   */
  constructor({ privateKey, identity, agentId, network = {} }) {
    if (!privateKey && !identity) throw new Error('[SavantDex] privateKey or identity is required')
    this.#agentId  = agentId
    this._signerMode = !privateKey  // true when identity (RemoteSignerIdentity) is used
    this.#pendingResults = new Map()
    this.#resultSubscription = null
    this.#seenTaskIds = new Map()
    this.#seenResultTaskIds = new Map()
    this.#trustedTaskPublishers = new Set(
      ((network.trustedTaskPublishers?.join(','))
        || (typeof process !== 'undefined' ? process.env.TRUSTED_GATEWAY_ADDRESSES : '')
        || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
    this.#client = new StreamrClient({
      auth: privateKey ? { privateKey } : { identity },
      network: {
        controlLayer: {
          websocketPortRange: network.websocketPort
            ? { min: network.websocketPort, max: network.websocketPortMax ?? network.websocketPort + 10 }
            : undefined,
          externalIp: network.externalIp
        }
      }
    })
  }

  /** Returns this agent's Ethereum address */
  async getAddress() {
    if (!this.#address) this.#address = await this.#client.getAddress()
    return this.#address
  }

  /** Returns the stream ID for this agent's inbox */
  async getStreamId() {
    if (!this.#streamId) {
      const addr = await this.getAddress()
      this.#streamId = `${addr.toLowerCase()}/savantdex/${this.#agentId}`
    }
    return this.#streamId
  }

  /**
   * Register this agent - creates its inbox stream if not exists, opens public subscribe
   * Call once on first run (costs POL gas). Subsequent runs skip if stream exists.
   *
   * Signer mode (identity-based):
   *   Does NOT create or modify the stream — that requires an on-chain transaction
   *   which needs a full private key (getTransactionSigner). Instead, this method
   *   verifies that the stream already exists and has public PUBLISH + SUBSCRIBE.
   *   If the stream is missing or permissions are absent, a clear error is thrown
   *   explaining how to pre-create it using setup mode.
   *
   *   Pre-create the stream once:
   *     KEYSTORE_PATH=./setup.keystore.json \
   *       node -e "import('./sdk/index.mjs').then(m => new m.SavantDex({ privateKey, agentId }).register())"
   *   Or keep calling register() with the setup key on first run.
   */
  async register() {
    const streamId = await this.getStreamId()

    if (this._signerMode) {
      // Signer mode: verify pre-created stream; never attempt on-chain write
      let stream
      try {
        stream = await this.#client.getStream(streamId)
      } catch {
        throw new Error(
          `[SavantDex] Stream not found in signer mode: ${streamId}\n` +
          `  Pre-create it once using setup mode (direct privateKey), then switch to signer mode.\n` +
          `  Setup: KEYSTORE_PATH=./setup.keystore.json node -e "...new SavantDex({ privateKey, agentId }).register()"`
        )
      }
      const isPublicSub = await stream.hasPermission({ permission: StreamPermission.SUBSCRIBE, public: true })
      const isPublicPub = await stream.hasPermission({ permission: StreamPermission.PUBLISH, public: true })
      if (!isPublicSub || !isPublicPub) {
        throw new Error(
          `[SavantDex] Stream missing public permissions in signer mode: ${streamId}\n` +
          `  Grant them using setup mode (direct privateKey), then switch to signer mode.`
        )
      }
      console.log(`[SavantDex] Stream verified (signer mode): ${streamId}`)
      return streamId
    }

    // Key mode: create stream if needed, grant permissions
    const stream = await this.#client.getOrCreateStream({ id: `/savantdex/${this.#agentId}` })

    const isPublicSub = await stream.hasPermission({ permission: StreamPermission.SUBSCRIBE, public: true })
    const isPublicPub = await stream.hasPermission({ permission: StreamPermission.PUBLISH, public: true })
    const toGrant = []
    if (!isPublicSub) toGrant.push(StreamPermission.SUBSCRIBE)
    if (!isPublicPub) toGrant.push(StreamPermission.PUBLISH)
    if (toGrant.length > 0) {
      await stream.grantPermissions({ permissions: toGrant, public: true })
    }

    console.log(`[SavantDex] Registered: ${streamId}`)
    return streamId
  }

  /**
   * Send a task to another agent
   * @param {string} targetStreamId - Target agent's stream ID
   * @param {object} task           - Task payload
   * @param {string} task.type      - Task type identifier
   * @param {any}    task.input     - Task input data
   * @returns {string} taskId
   */
  async sendTask(targetStreamId, { type, input, taskId: providedTaskId }) {
    const taskId = providedTaskId || `task-${randomBytes(16).toString('hex')}`
    const replyStreamId = await this.getStreamId()

    await this.#client.publish(targetStreamId, {
      taskId,
      type,
      input,
      replyTo: replyStreamId,
      from: await this.getAddress(),
      ts: Date.now()
    })

    console.log(`[SavantDex] Task sent: ${taskId} → ${targetStreamId}`)
    return taskId
  }

  /**
   * Listen for incoming tasks
   * @param {function} handler - async (task, reply) => void
   *   reply(result) sends result back to requester
   */
  async onTask(handler) {
    const streamId = await this.getStreamId()
    await this.#client.subscribe(streamId, async (content, metadata) => {
      const msg = normalizeIncomingMessage(content, metadata)
      // Outer catch: prevent ANY exception from escaping the subscribe callback.
      // An uncaught async exception here reaches the Streamr SDK's internal
      // unhandledRejection handler, which tears down the entire network stack
      // and stops the worker from receiving future tasks.
      try {
        if (!msg.taskId) return
        const publisherId = getPublisherId(msg)
        pruneSeenTaskIds(this.#seenTaskIds)
        if (this.#seenTaskIds.has(msg.taskId)) {
          console.warn(`[SavantDex] Dropped replayed task ${msg.taskId}`)
          return
        }
        if (this.#trustedTaskPublishers.size > 0 && !publisherId) {
          console.warn(`[SavantDex] Dropped task ${msg.taskId}: publisher unavailable`)
          return
        }
        if (this.#trustedTaskPublishers.size > 0 && !this.#trustedTaskPublishers.has(publisherId)) {
          console.warn(`[SavantDex] Dropped task ${msg.taskId}: untrusted publisher ${publisherId}`)
          return
        }
        this.#seenTaskIds.set(msg.taskId, Date.now())

        console.log(`[SavantDex] Task received: ${msg.taskId} (${msg.type})`)

        const reply = async (output) => {
          if (!msg.replyTo) return
          const replyOwner = getStreamOwner(msg.replyTo)
          if (!replyOwner || (publisherId && replyOwner !== publisherId)) {
            console.warn(`[SavantDex] Dropped reply for ${msg.taskId}: invalid replyTo ${msg.replyTo}`)
            return
          }
          try {
            await this.#client.publish(msg.replyTo, {
              taskId: msg.taskId,
              type: 'result',
              output,
              from: await this.getAddress(),
              ts: Date.now()
            })
            console.log(`[SavantDex] Result sent: ${msg.taskId} → ${msg.replyTo}`)
          } catch (err) {
            // Reply stream may not exist (e.g. requester used a stream that was
            // never set up). Log and continue — this task's reply is lost, but
            // the worker must keep processing future tasks.
            console.warn(`[SavantDex] Reply failed for ${msg.taskId} → ${msg.replyTo}: ${err.message}`)
          }
        }

        try {
          await handler(msg, reply)
        } catch (err) {
          console.error(`[SavantDex] Handler error for ${msg.taskId}:`, err.message)
          // Best-effort error reply — also guarded so it cannot throw.
          await reply({ error: err.message })
        }
      } catch (err) {
        // Should never reach here, but if it does, log and swallow to protect
        // the Streamr subscription from being disrupted.
        console.error(`[SavantDex] Unexpected error in task callback:`, err.message)
      }
    })

    console.log(`[SavantDex] Listening on: ${streamId}`)
  }

  /**
   * Wait for a result matching taskId
   * @param {string} taskId
   * @param {number} timeout - ms
   */
  async waitForResult(taskId, timeout = 30000, expectedPublisherId = null) {
    const expected = expectedPublisherId ? expectedPublisherId.toLowerCase() : null
    await this.#ensureResultSubscription()
    return new Promise((resolve, reject) => {
      if (this.#pendingResults.has(taskId)) {
        reject(new Error(`Duplicate waitForResult for ${taskId}`))
        return
      }
      const timer = setTimeout(() => {
        this.#pendingResults.delete(taskId)
        reject(new Error(`Timeout waiting for ${taskId}`))
      }, timeout)
      this.#pendingResults.set(taskId, { resolve, reject, timer, expected })
    })
  }

  async destroy() {
    if (this.#resultSubscription?.unsubscribe) {
      await this.#resultSubscription.unsubscribe()
    }
    await this.#client.destroy()
  }

  async #ensureResultSubscription() {
    if (this.#resultSubscription) return
    const streamId = await this.getStreamId()
    this.#resultSubscription = await this.#client.subscribe(streamId, async (content, metadata) => {
      const msg = normalizeIncomingMessage(content, metadata)
      if (msg?.type !== 'result' || !msg?.taskId) return
      pruneSeenTaskIds(this.#seenResultTaskIds)
      if (this.#seenResultTaskIds.has(msg.taskId)) return
      const pending = this.#pendingResults.get(msg.taskId)
      if (!pending) return
      const publisherId = getPublisherId(msg)
      if (pending.expected && publisherId !== pending.expected) return
      clearTimeout(pending.timer)
      this.#pendingResults.delete(msg.taskId)
      this.#seenResultTaskIds.set(msg.taskId, Date.now())
      pending.resolve(msg.output)
    })
  }
}

function getPublisherId(msg) {
  if (msg?.publisherId) return String(msg.publisherId).toLowerCase()
  if (typeof msg?.getPublisherId === 'function') {
    const publisherId = msg.getPublisherId()
    return typeof publisherId === 'string' ? publisherId.toLowerCase() : null
  }
  if (msg?.messageId?.publisherId) return String(msg.messageId.publisherId).toLowerCase()
  return null
}

function normalizeIncomingMessage(content, metadata) {
  const normalized = (content && typeof content === 'object') ? { ...content } : { value: content }
  if (metadata && typeof metadata === 'object') {
    if (metadata.publisherId && !normalized.publisherId) {
      normalized.publisherId = metadata.publisherId
    }
    if (metadata.messageId && !normalized.messageId) {
      normalized.messageId = metadata.messageId
    }
    if (typeof metadata.getPublisherId === 'function' && typeof normalized.getPublisherId !== 'function') {
      normalized.getPublisherId = metadata.getPublisherId.bind(metadata)
    }
  }
  return normalized
}

function getStreamOwner(streamId) {
  if (typeof streamId !== 'string' || !streamId.includes('/')) return null
  return streamId.split('/')[0].toLowerCase()
}

function pruneSeenTaskIds(seenTaskIds, now = Date.now()) {
  const cutoff = now - 10 * 60 * 1000
  for (const [taskId, seenAt] of seenTaskIds) {
    if (seenAt < cutoff) seenTaskIds.delete(taskId)
  }
}
