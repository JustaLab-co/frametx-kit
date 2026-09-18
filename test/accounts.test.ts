import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toFrameAccount } from '../src/accounts/toFrameAccount.js'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
import { recoverFrameSigner } from '../src/signatures.js'
import type { FrameTransaction } from '../src/types.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const

describe('toFrameAccount', () => {
  test('resolves methods and extensions', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() { throw new Error('unexpected RPC request') } }),
    })
    const address = getAddress('0x0000000000000000000000000000000000001234')
    const account = await toFrameAccount({
      client,
      owner,
      execution: { type: 'direct' },
      extend: { implementationName: 'test-account' as const },
      async getAddress() { return address },
      async getNonce() { return 1n },
      async getValidationData({ nonce }) { return nonce === 1n ? '0xabcd' : '0x' },
      async signFrameTransaction(transaction) { return transaction },
    })

    expect(account.address).toBe(address)
    expect(account.type).toBe('frame')
    expect(account.implementationName).toBe('test-account')
    expect(await account.getNonce()).toBe(1n)
    expect(await account.getValidationData({ calls: [], chainId: 1n, nonce: 1n })).toBe('0xabcd')
    expect(await account.signFrameTransaction(GOLDEN_TX as FrameTransaction)).toBe(GOLDEN_TX)
  })

  test('resolved fields override extension properties', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      execution: { type: 'direct' },
      extend: { address: 'extension-value', type: 'extension-value' },
      getAddress: async () => owner.address,
      getNonce: async () => 0n,
      getValidationData: async () => '0x',
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(account.address).toBe(owner.address)
    expect(account.type).toBe('frame')
  })
})

describe('toEoaFrameAccount', () => {
  test('uses default-code validation and signs as the EOA', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toEoaFrameAccount({ client, owner })
    const unsigned = { ...GOLDEN_TX, sender: owner.address, signatures: [] }

    expect(await account.getValidationData({ calls: [], chainId: 1n, nonce: 0n })).toBe('0x')
    const signed = await account.signFrameTransaction(unsigned)
    expect(signed.signatures[0]).toMatchObject({ scheme: 1, signer: null, msg: '0x' })
    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
  })

  test('reads the pending scalar account nonce', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const requests: { method: string; params?: unknown }[] = []
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          return '0x7'
        },
      }),
    })
    const account = await toEoaFrameAccount({ client, owner })

    expect(await account.getNonce()).toBe(7n)
    expect(requests).toEqual([
      { method: 'eth_getTransactionCount', params: [owner.address, 'pending'] },
    ])
  })

  test('rejects a transaction whose sender is not the EOA', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toEoaFrameAccount({ client, owner })
    await expect(account.signFrameTransaction(GOLDEN_TX)).rejects.toThrow(/does not match EOA/)
  })
})
