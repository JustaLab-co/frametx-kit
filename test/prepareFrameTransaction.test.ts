import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
import { toEoaFramePayerAccount } from '../src/accounts/toEoaFramePayerAccount.js'
import { toFramePayerAccount } from '../src/accounts/toFramePayerAccount.js'
import { keyedNonceSlot } from '../src/nonce.js'
import { prepareFrameTransaction } from '../src/prepareFrameTransaction.js'
import { signFrameTransaction } from '../src/signFrameTransaction.js'
import { assertValidFrameTx, recoverFrameSigner } from '../src/signatures.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const

async function contractPayer(
  owner: ReturnType<typeof privateKeyToAccount>,
  address: ReturnType<typeof getAddress>,
  data: `0x${string}` = '0x',
) {
  return toFramePayerAccount({
    owner,
    getAddress: async () => address,
    getPayData: async () => data,
    getSignatureEntries: async () => [],
    signFrameTransaction: async (transaction) => transaction,
  })
}

/** `storage` maps a NONCE_MANAGER slot to its value; unlisted slots read zero. */
function testClient(storage: Record<string, bigint> = {}) {
  const requests: { method: string; params?: unknown }[] = []
  const owner = privateKeyToAccount(OWNER_KEY)
  const client = createClient({
    account: owner,
    chain: { ...mainnet, id: 8_141 },
    transport: custom({
      async request(request) {
        requests.push(request)
        switch (request.method) {
          case 'eth_getTransactionCount': return '0x7'
          case 'eth_getStorageAt': {
            const slot = (request.params as string[])[1]!
            return `0x${(storage[slot] ?? 0n).toString(16).padStart(64, '0')}`
          }
          case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
          case 'eth_gasPrice': return '0x77359400'
          case 'eth_getBlockByNumber': return { baseFeePerGas: '0x77359400' }
          default: throw new Error(`unexpected RPC method ${request.method}`)
        }
      },
    }),
  })
  return { client, owner, requests }
}

describe('prepareFrameTransaction', () => {
  test('builds a VERIFY frame and one SENDER frame per call', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const first = getAddress('0x0000000000000000000000000000000000001234')
    const second = getAddress('0x0000000000000000000000000000000000005678')

    const transaction = await prepareFrameTransaction(
      account,
      [
        { to: first, value: 1n, data: '0x' },
        { to: second, value: 2n, data: '0x1234' },
      ],
      {
        validation: { execution: 80_000n, state: 0n },
        calls: [
          { execution: 30_000n, state: 100_000n },
          { execution: 40_000n, state: 200_000n },
        ],
      },
    )

    expect(transaction).toMatchObject({
      chainId: 8_141n,
      nonceKeys: [0n],
      nonceSeq: 7n,
      sender: owner.address,
      signatures: [
        { scheme: 1, signer: null, msg: '0x', signature: '0x' },
      ],
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 5_000_000_000n,
      maxFeePerBlobGas: 0n,
      blobVersionedHashes: [],
    })
    expect(transaction.frames).toEqual([
      {
        mode: 1,
        flags: 3,
        target: null,
        limits: { execution: 80_000n, state: 0n },
        value: 0n,
        data: '0x',
      },
      {
        mode: 2,
        flags: 0,
        target: first,
        limits: { execution: 30_000n, state: 100_000n },
        value: 1n,
        data: '0x',
      },
      {
        mode: 2,
        flags: 0,
        target: second,
        limits: { execution: 40_000n, state: 200_000n },
        value: 2n,
        data: '0x1234',
      },
    ])

    const signed = await account.signFrameTransaction(transaction)
    expect(() => assertValidFrameTx(signed)).not.toThrow()
    expect(requests.some(({ method }) => method === 'eth_chainId')).toBe(false)
  })

  test('builds only_verify and pay frames before sponsored calls', async () => {
    const { client, owner } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const paymaster = getAddress('0x0000000000000000000000000000000000009999')
    const payer = await contractPayer(owner, paymaster, '0xabcdef')
    const recipient = getAddress('0x0000000000000000000000000000000000001234')

    const transaction = await prepareFrameTransaction(
      account,
      [{ to: recipient, value: 1n, data: '0x1234' }],
      {
        validation: { execution: 80_000n, state: 0n },
        calls: [{ execution: 30_000n, state: 100_000n }],
      },
      {
        paymaster: {
          account: payer,
          limits: { execution: 60_000n, state: 200_000n },
        },
      },
    )

    expect(transaction.frames).toEqual([
      {
        mode: 1,
        flags: 0x2,
        target: null,
        limits: { execution: 80_000n, state: 0n },
        value: 0n,
        data: '0x',
      },
      {
        mode: 1,
        flags: 0x1,
        target: paymaster,
        limits: { execution: 60_000n, state: 200_000n },
        value: 0n,
        data: '0xabcdef',
      },
      {
        mode: 2,
        flags: 0,
        target: recipient,
        limits: { execution: 30_000n, state: 100_000n },
        value: 1n,
        data: '0x1234',
      },
    ])
  })

  test('prepares and signs with a distinct codeless EOA payer', async () => {
    const { client, owner } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const payerOwner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const payer = await toEoaFramePayerAccount({ owner: payerOwner })

    const transaction = await prepareFrameTransaction(
      account,
      [{ to: owner.address, value: 1n, data: '0x' }],
      {
        validation: { execution: 80_000n, state: 0n },
        calls: [{ execution: 30_000n, state: 0n }],
      },
      {
        paymaster: {
          account: payer,
          limits: { execution: 30_000n, state: 200_000n },
        },
      },
    )

    expect(transaction.signatures).toEqual([
      { scheme: 1, signer: null, msg: '0x', signature: '0x' },
      { scheme: 1, signer: payer.address, msg: '0x', signature: '0x' },
    ])

    const signed = await signFrameTransaction(account, transaction, { payer })
    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
    expect(await recoverFrameSigner(signed, 1)).toBe(payer.address)
    expect(() => assertValidFrameTx(signed)).not.toThrow()
  })

  test('rejects negative paymaster limits before making RPC requests', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const payer = await contractPayer(owner, owner.address)

    await expect(
      prepareFrameTransaction(
        account,
        [{ to: owner.address, value: 0n, data: '0x' }],
        { validation: { execution: 1n, state: 0n }, calls: [{ execution: 1n, state: 0n }] },
        {
          paymaster: {
            account: payer,
            limits: { execution: -1n, state: 0n },
          },
        },
      ),
    ).rejects.toThrow(/paymaster\.limits\.execution must not be negative/)
    expect(requests).toEqual([])
  })

  test('accounts for the pay frame in the transaction frame limit', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const payer = await contractPayer(owner, owner.address)
    const calls = Array.from({ length: 63 }, () => ({
      to: owner.address,
      value: 0n,
      data: '0x' as const,
    }))

    await expect(
      prepareFrameTransaction(
        account,
        calls,
        {
          validation: { execution: 1n, state: 0n },
          calls: calls.map(() => ({ execution: 1n, state: 0n })),
        },
        {
          paymaster: {
            account: payer,
            limits: { execution: 1n, state: 0n },
          },
        },
      ),
    ).rejects.toThrow(/at most 62 calls with 2 validation frames/)
    expect(requests).toEqual([])
  })

  test('selects non-zero keys at their shared NONCE_MANAGER sequence', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const [one, nine] = [1n, 9n].map((key) => keyedNonceSlot(owner.address, key))
    const { client } = testClient({ [one!]: 4n, [nine!]: 4n })
    const account = await toEoaFrameAccount({ client, owner })

    const transaction = await prepareFrameTransaction(
      account,
      [{ to: owner.address, value: 0n, data: '0x' }],
      { validation: { execution: 1n, state: 0n }, calls: [{ execution: 1n, state: 0n }] },
      { nonceKeys: [1n, 9n] },
    )
    expect(transaction.nonceKeys).toEqual([1n, 9n])
    expect(transaction.nonceSeq).toBe(4n)
  })

  test('refuses keys that sit at different sequences', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const { client } = testClient({ [keyedNonceSlot(owner.address, 2n)]: 1n })
    const account = await toEoaFrameAccount({ client, owner })

    await expect(
      prepareFrameTransaction(
        account,
        [{ to: owner.address, value: 0n, data: '0x' }],
        { validation: { execution: 1n, state: 0n }, calls: [{ execution: 1n, state: 0n }] },
        { nonceKeys: [2n, 3n] },
      ),
    ).rejects.toThrow(/different sequences: key 2 is at 1, key 3 is at 0/)
  })

  test.each([
    ['empty', [], /between 1 and 16 entries, got 0/],
    ['too many', Array.from({ length: 17 }, (_, i) => BigInt(i + 1)), /between 1 and 16 entries, got 17/],
    ['out of order', [2n, 1n], /strictly increasing/],
    ['duplicated', [1n, 1n], /strictly increasing/],
    ['key 0 with another key', [0n, 1n], /key 0 is only valid as the sole nonce key/],
    ['negative', [-1n], /nonceKeys\[0\]/],
  ])('refuses nonceKeys (%s) before making RPC requests', async (_, nonceKeys, message) => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })

    await expect(
      prepareFrameTransaction(
        account,
        [{ to: owner.address, value: 0n, data: '0x' }],
        { validation: { execution: 1n, state: 0n }, calls: [{ execution: 1n, state: 0n }] },
        { nonceKeys },
      ),
    ).rejects.toThrow(message)
    expect(requests).toEqual([])
  })

  test('requires one call-limit entry per call', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })

    await expect(
      prepareFrameTransaction(
        account,
        [{ to: owner.address, value: 0n, data: '0x' }],
        { validation: { execution: 1n, state: 0n }, calls: [] },
      ),
    ).rejects.toThrow(/one entry per call/)
    expect(requests).toEqual([])
  })

  test('rejects negative frame limits before making RPC requests', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })

    await expect(
      prepareFrameTransaction(
        account,
        [{ to: owner.address, value: 0n, data: '0x' }],
        {
          validation: { execution: 1n, state: 0n },
          calls: [{ execution: -1n, state: 0n }],
        },
      ),
    ).rejects.toThrow(/execution must not be negative/)
    expect(requests).toEqual([])
  })
})
