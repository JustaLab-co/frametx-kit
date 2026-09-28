import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress, keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
import { toEoaFramePayerAccount } from '../src/accounts/toEoaFramePayerAccount.js'
import { decodeFrameTx } from '../src/envelope.js'
import { sendFrameTransaction } from '../src/sendFrameTransaction.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const
const PAYER_KEY = `0x${'22'.repeat(32)}` as const

function testClient() {
  const owner = privateKeyToAccount(OWNER_KEY)
  const requests: { method: string; params?: unknown }[] = []
  let submittedRaw: Hex | undefined
  const client = createClient({
    account: owner,
    chain: { ...mainnet, id: 8_141 },
    transport: custom({
      async request(request) {
        requests.push(request)
        switch (request.method) {
          case 'eth_getTransactionCount': return '0x7'
          case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
          case 'eth_gasPrice': return '0x77359400'
          case 'eth_getBlockByNumber': return { baseFeePerGas: '0x77359400' }
          case 'eth_sendRawTransaction': {
            submittedRaw = (request.params as [Hex])[0]
            return keccak256(submittedRaw)
          }
          default: throw new Error(`unexpected RPC method ${request.method}`)
        }
      },
    }),
  })
  return { client, owner, requests, getSubmittedRaw: () => submittedRaw }
}

describe('sendFrameTransaction', () => {
  test('defaults optional call fields and returns the node hash', async () => {
    const { client, owner, getSubmittedRaw } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const recipient = getAddress('0x0000000000000000000000000000000000001234')

    const limits = {
      validation: { execution: 30_000n, state: 0n },
      calls: [{ execution: 40_000n, state: 200_000n }],
    }
    const hash = await sendFrameTransaction(account, [{ to: recipient }], {
      limits,
    })
    const raw = getSubmittedRaw()
    expect(raw).toBeDefined()
    expect(hash).toBe(keccak256(raw!))

    const transaction = decodeFrameTx(raw!)
    expect(transaction.frames[0]!.limits).toEqual(limits.validation)
    expect(transaction.frames[1]).toMatchObject({
      target: recipient,
      value: 0n,
      data: '0x',
      limits: limits.calls[0],
    })
  })

  test('applies overrides and signs with a distinct EOA payer', async () => {
    const { client, owner, getSubmittedRaw } = testClient()
    const account = await toEoaFrameAccount({ client, owner })
    const payer = await toEoaFramePayerAccount({
      owner: privateKeyToAccount(PAYER_KEY),
    })

    await sendFrameTransaction(
      account,
      [{ to: owner.address, value: 1n }],
      {
        limits: {
          validation: { execution: 20_000n, state: 0n },
          calls: [{ execution: 40_000n, state: 10_000n }],
        },
        paymaster: {
          account: payer,
          limits: { execution: 25_000n, state: 100_000n },
        },
      },
    )

    const transaction = decodeFrameTx(getSubmittedRaw()!)
    expect(transaction.frames.map((frame) => frame.limits)).toEqual([
      { execution: 20_000n, state: 0n },
      { execution: 25_000n, state: 100_000n },
      { execution: 40_000n, state: 10_000n },
    ])
    expect(transaction.signatures).toHaveLength(2)
  })

  test('requires one per-call override for every call', async () => {
    const { client, owner, requests } = testClient()
    const account = await toEoaFrameAccount({ client, owner })

    await expect(
      sendFrameTransaction(
        account,
        [{ to: owner.address }, { to: owner.address }],
        {
          limits: {
            validation: { execution: 1n, state: 0n },
            calls: [{ execution: 1n, state: 0n }],
          },
        },
      ),
    ).rejects.toThrow(/expected 2, got 1/)
    expect(requests).toEqual([])
  })
})
