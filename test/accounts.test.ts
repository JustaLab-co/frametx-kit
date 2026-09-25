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
      async getValidationData({ nonceSeq }) { return nonceSeq === 1n ? '0xabcd' : '0x' },
      async signFrameTransaction(transaction) { return transaction },
    })

    expect(account.address).toBe(address)
    expect(account.type).toBe('frame')
    expect(account.implementationName).toBe('test-account')
    expect(await account.getNonce()).toBe(1n)
    expect(
      await account.getValidationData({ calls: [], chainId: 1n, nonceKeys: [0n], nonceSeq: 1n }),
    ).toBe('0xabcd')
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

    expect(
      await account.getValidationData({ calls: [], chainId: 1n, nonceKeys: [0n], nonceSeq: 0n }),
    ).toBe('0x')
    const signed = await account.signFrameTransaction(unsigned)
    expect(signed.signatures[0]).toMatchObject({ scheme: 1, signer: null, msg: '0x' })
    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
  })

  test('reads key 0 from the pending account nonce', async () => {
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

  test('reads a non-zero key from its NONCE_MANAGER slot', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const requests: { method: string; params?: unknown }[] = []
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          return `0x${'00'.repeat(31)}03`
        },
      }),
    })
    const account = await toEoaFrameAccount({ client, owner })

    expect(await account.getNonce({ key: 5n, blockTag: 'latest' })).toBe(3n)
    // Slot computed independently: `cast keccak` over
    // left_pad_32(0x19E7…ff2A) || uint256(5).
    expect(requests).toEqual([
      {
        method: 'eth_getStorageAt',
        params: [
          '0x0000000000000000000000000000000000008250',
          '0x91532bb988e1829b215838c387168ecc92dc12a6ace9895d81f60d6eebf505d4',
          'latest',
        ],
      },
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
