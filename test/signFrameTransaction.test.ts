import { describe, expect, test, vi } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toFrameAccount } from '../src/accounts/toFrameAccount.js'
import { toFramePayerAccount } from '../src/accounts/toFramePayerAccount.js'
import { signFrameTransaction } from '../src/signFrameTransaction.js'
import { recoverFrameSigner } from '../src/signatures.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const

describe('signFrameTransaction', () => {
  test('delegates signing to the frame account and returns the signed transaction', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    const unsigned = { ...GOLDEN_TX, sender: owner.address, signatures: [] }
    const spy = vi.spyOn(account, 'signFrameTransaction')

    const signed = await signFrameTransaction(account, unsigned)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(unsigned)
    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
  })

  test('rejects a transaction for a different sender before signing', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    const spy = vi.spyOn(account, 'signFrameTransaction')

    await expect(
      signFrameTransaction(account, {
        ...GOLDEN_TX,
        sender: getAddress('0x0000000000000000000000000000000000001234'),
      }),
    ).rejects.toThrow(/does not match frame account/)
    expect(spy).not.toHaveBeenCalled()
  })

  test('signs sender index 0 and distinct EOA payer index 1', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const payerOwner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    const payer = await toFramePayerAccount({ owner: payerOwner })
    const base = {
      ...GOLDEN_TX,
      sender: owner.address,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x2, target: null },
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payer.address,
          data: '0x' as const,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [],
    }
    const senderEntries = await account.getSignatureEntries(base)
    const withSenderEntries = { ...base, signatures: [...senderEntries] }
    const payerEntries = await payer.getSignatureEntries(withSenderEntries)
    const prepared = {
      ...withSenderEntries,
      signatures: [...withSenderEntries.signatures, ...payerEntries],
    }

    const signed = await signFrameTransaction(account, prepared, { payer })

    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
    expect(await recoverFrameSigner(signed, 1)).toBe(payerOwner.address)
  })

  test('signs separate first and last entries when sender and payer share an owner', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const sender = getAddress('0x0000000000000000000000000000000000001234')
    const payerAddress = getAddress('0x0000000000000000000000000000000000009999')
    const delegate = getAddress('0x0000000000000000000000000000000000005678')
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({
        async request({ method }) {
          if (method === 'eth_getCode') return `0xef0100${delegate.slice(2)}`
          throw new Error(`unexpected ${method}`)
        },
      }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      address: sender,
      delegateAddress: delegate,
    })
    const payer = await toFramePayerAccount({ owner, address: payerAddress })
    const base = {
      ...GOLDEN_TX,
      sender,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x2, target: null },
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payerAddress,
          data: '0x' as const,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [],
    }
    const senderEntries = await account.getSignatureEntries(base)
    const payerEntries = await payer.getSignatureEntries(base)
    const prepared = {
      ...base,
      signatures: [...senderEntries, ...payerEntries],
    }

    expect(prepared.signatures).toEqual([
      { scheme: 1, signer: owner.address, msg: '0x', signature: '0x' },
      { scheme: 1, signer: owner.address, msg: '0x', signature: '0x' },
    ])

    const signed = await signFrameTransaction(account, prepared, { payer })

    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
    expect(await recoverFrameSigner(signed, 1)).toBe(owner.address)
  })
})
