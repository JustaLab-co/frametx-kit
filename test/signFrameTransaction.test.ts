import { describe, expect, test, vi } from 'vitest'
import { createClient, custom, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { toEoaFrameAccount } from '../src/accounts/toEoaFrameAccount.js'
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
    const account = await toEoaFrameAccount({ client, owner })
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
    const account = await toEoaFrameAccount({ client, owner })
    const spy = vi.spyOn(account, 'signFrameTransaction')

    await expect(
      signFrameTransaction(account, {
        ...GOLDEN_TX,
        sender: getAddress('0x0000000000000000000000000000000000001234'),
      }),
    ).rejects.toThrow(/does not match frame account/)
    expect(spy).not.toHaveBeenCalled()
  })
})
