/**
 * SavantDex RemoteSignerIdentity
 *
 * Implements the Streamr SDK's abstract Identity class by delegating
 * all signing to an external signer server (savantdex/signer/server.mjs).
 *
 * The process using this class holds NO private key — only the address
 * and the URL of the signer server are needed.
 *
 * Usage:
 *   import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
 *   const identity = new RemoteSignerIdentity('0x...', 17099)
 *   const agent = new SavantDex({ identity, agentId: 'my-agent', ... })
 *
 * Note: Uses regular properties (not JS private fields #) because this class
 * extends a CJS bundle (Streamr SDK). Private field brand checks fail across
 * ESM→CJS module boundaries in Node.js, so _ prefix is used instead.
 */

import { Identity, SignatureType } from '@streamr/sdk'

export class RemoteSignerIdentity extends Identity {
  _address
  _signerUrl

  /**
   * @param {string} address   Ethereum address of the signer (0x-prefixed)
   * @param {number} port      Port of the signer server (default: 17099)
   */
  constructor(address, port = 17099) {
    super()
    this._address   = address.toLowerCase()
    this._signerUrl = `http://127.0.0.1:${port}/sign-message`
  }

  getUserId() {
    return Promise.resolve(this._address)
  }

  getUserIdRaw() {
    return Promise.resolve(Buffer.from(this._address.slice(2), 'hex'))
  }

  getSignatureType() {
    return SignatureType.ECDSA_SECP256K1_EVM
  }

  async createMessageSignature(payload) {
    const res = await fetch(this._signerUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ payload: Buffer.from(payload).toString('hex') }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Signer server error ${res.status}: ${text}`)
    }

    const { signature } = await res.json()
    // Convert hex signature to Uint8Array (65 bytes: r|s|v)
    return Buffer.from(signature.slice(2), 'hex')
  }

  async getTransactionSigner() {
    throw new Error(
      '[RemoteSignerIdentity] getTransactionSigner not implemented. ' +
      'Stream management (createStream, grantPermissions) requires on-chain signing. ' +
      'Pre-create the stream or use a direct privateKey for setup.'
    )
  }
}
