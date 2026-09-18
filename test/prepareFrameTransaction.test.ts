import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
import { prepareFrameTransaction } from '../src/prepareFrameTransaction.js'
import { assertValidFrameTx } from '../src/signatures.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const

function testClient() {
  const requests: { method: string; params?: unknown }[] = []
  const owner = privateKeyToAccount(OWNER_KEY)
  const client = createClient({
    account: owner,
    chain: { ...mainnet, id: 81_410 },
    transport: custom({
      async request(request) {
        requests.push(request)
        switch (request.method) {
          case 'eth_getTransactionCount': return '0x7'
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
      chainId: 81_410n,
      nonce: 7n,
      sender: owner.address,
      signatures: [],
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
