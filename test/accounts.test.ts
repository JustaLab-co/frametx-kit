import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toFrameAccount } from '../src/accounts/toFrameAccount.js'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
import { toEoaFramePayerAccount } from '../src/accounts/toEoaFramePayerAccount.js'
import { toFramePayerAccount } from '../src/accounts/toFramePayerAccount.js'
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
      async getSignatureEntries() { return [] },
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
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(account.address).toBe(owner.address)
    expect(account.type).toBe('frame')
  })
})

describe('toEoaFramePayerAccount', () => {
  test('uses default-code payment approval and signs index 1 as the payer', async () => {
    const sender = privateKeyToAccount(OWNER_KEY)
    const payerOwner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const payer = await toEoaFramePayerAccount({ owner: payerOwner })
    const transaction = {
      ...GOLDEN_TX,
      sender: sender.address,
      frames: [
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payerOwner.address,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    expect(payer.address).toBe(payerOwner.address)
    expect(payer.type).toBe('framePayer')
    expect(await payer.getPayData(transaction)).toBe('0x')

    const entries = await payer.getSignatureEntries(transaction)
    expect(entries).toEqual([
      { scheme: 1, signer: payerOwner.address, msg: '0x', signature: '0x' },
    ])

    const signed = await payer.signFrameTransaction({
      ...transaction,
      signatures: [...transaction.signatures, ...entries],
    })
    expect(await recoverFrameSigner(signed, 1)).toBe(payerOwner.address)
  })

  test('requires its signature metadata at protocol-reserved index 1', async () => {
    const payer = await toEoaFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })

    await expect(
      payer.getSignatureEntries({
        ...GOLDEN_TX,
        frames: [
          {
            ...GOLDEN_TX.frames[0]!,
            flags: 0x1,
            target: payer.address,
          },
          ...GOLDEN_TX.frames.slice(1),
        ],
        signatures: [],
      }),
    ).rejects.toThrow(/inserted at index 1/)
  })

  test('refuses to sign without a pay frame targeting the payer', async () => {
    const payer = await toEoaFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })

    await expect(
      payer.signFrameTransaction({ ...GOLDEN_TX, signatures: [] }),
    ).rejects.toThrow(/no payment-only VERIFY frame/)
  })
})

describe('toFramePayerAccount', () => {
  test('resolves methods and extensions', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const address = getAddress('0x0000000000000000000000000000000000009999')
    const payer = await toFramePayerAccount({
      owner,
      extend: { implementationName: 'test-payer' as const },
      getAddress: async () => address,
      getPayData: async (_transaction: FrameTransaction) => '0xabcd',
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(payer.address).toBe(address)
    expect(payer.type).toBe('framePayer')
    expect(payer.implementationName).toBe('test-payer')
    expect(await payer.getPayData(GOLDEN_TX)).toBe('0xabcd')
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
