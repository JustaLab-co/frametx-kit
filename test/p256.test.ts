import { describe, expect, test } from 'vitest'
import {
  concatHex,
  createClient,
  custom,
  getAddress,
  numberToHex,
  sliceHex,
} from 'viem'
import { mainnet } from 'viem/chains'
import * as P256 from 'ox/P256'
import { toP256FrameAccount } from '../src/accounts/toP256FrameAccount.js'
import { FrameEncodeError } from '../src/errors.js'
import {
  type P256FrameSigner,
  p256SignerIdentity,
  privateKeyToP256Account,
} from '../src/p256.js'
import { frameTxSigHash } from '../src/sighash.js'
import {
  SECP256R1_N,
  assertCanonicalSignature,
  signFrameSignature,
} from '../src/signatures.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const PRIVATE_KEY = numberToHex(1n, { size: 32 })
const DELEGATED_EOA = getAddress('0x0000000000000000000000000000000000001234')

describe('P-256 signer identity', () => {
  test('private scalar 1 derives the published P-256 generator coordinates', () => {
    const signer = privateKeyToP256Account(PRIVATE_KEY)

    expect(signer.type).toBe('p256')
    expect(signer.publicKey).toBe(
      '0x046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
        '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    )
  })

  test('derives the independently pinned last-20-byte keccak identity', () => {
    const signer = privateKeyToP256Account(PRIVATE_KEY)

    expect(signer.address.toLowerCase()).toBe(
      '0xd3a9f047ad43d7e2e4e7e491f1fe2e657a2651b6',
    )
    expect(p256SignerIdentity(signer.publicKey)).toBe(signer.address)
  })

  test('rejects a public key that is not on P-256', () => {
    expect(() =>
      p256SignerIdentity(
        concatHex([
          '0x04',
          numberToHex(1n, { size: 32 }),
          numberToHex(1n, { size: 32 }),
        ]),
      ),
    ).toThrow(/not a point on the curve/)
  })
})

describe('signFrameSignature with a P-256 owner', () => {
  test('signs the raw frame sig-hash as r || s || qx || qy', async () => {
    const signer = privateKeyToP256Account(PRIVATE_KEY)
    const unsigned = {
      ...GOLDEN_TX,
      sender: DELEGATED_EOA,
      signatures: [
        {
          scheme: 2 as const,
          signer: signer.address,
          msg: '0x' as const,
          signature: '0x' as const,
        },
      ],
    }
    const hash = frameTxSigHash(unsigned)
    const signed = await signFrameSignature(unsigned, 0, signer)
    const bytes = signed.signatures[0]!.signature

    expect(bytes.length).toBe(2 + 128 * 2)
    expect(sliceHex(bytes, 64, 128)).toBe(sliceHex(signer.publicKey, 1))
    expect(() => assertCanonicalSignature(signed.signatures[0]!, 0)).not.toThrow()

    const signature = {
      r: BigInt(sliceHex(bytes, 0, 32)),
      s: BigInt(sliceHex(bytes, 32, 64)),
    }
    const publicKey = {
      prefix: 4 as const,
      x: BigInt(sliceHex(signer.publicKey, 1, 33)),
      y: BigInt(sliceHex(signer.publicKey, 33, 65)),
    }
    expect(P256.verify({ payload: hash, publicKey, signature })).toBe(true)
    expect(P256.verify({ payload: hash, publicKey, signature, hash: true })).toBe(false)
  })

  test('normalizes a valid high-s signer response', async () => {
    const base = privateKeyToP256Account(PRIVATE_KEY)
    const signer: P256FrameSigner = {
      ...base,
      async sign(parameters) {
        const signature = await base.sign(parameters)
        return concatHex([
          sliceHex(signature, 0, 32),
          numberToHex(SECP256R1_N - BigInt(sliceHex(signature, 32, 64)), {
            size: 32,
          }),
        ])
      },
    }
    const unsigned = {
      ...GOLDEN_TX,
      sender: DELEGATED_EOA,
      signatures: [
        { scheme: 2 as const, signer: signer.address, msg: '0x' as const, signature: '0x' as const },
      ],
    }
    const signed = await signFrameSignature(unsigned, 0, signer)
    const s = BigInt(sliceHex(signed.signatures[0]!.signature, 32, 64))

    expect(s).toBeLessThanOrEqual(SECP256R1_N / 2n)
  })

  test('rejects a signer response that does not verify', async () => {
    const base = privateKeyToP256Account(PRIVATE_KEY)
    const signer: P256FrameSigner = {
      ...base,
      async sign() {
        return concatHex([
          numberToHex(1n, { size: 32 }),
          numberToHex(1n, { size: 32 }),
        ])
      },
    }
    const unsigned = {
      ...GOLDEN_TX,
      sender: DELEGATED_EOA,
      signatures: [
        { scheme: 2 as const, signer: signer.address, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    await expect(signFrameSignature(unsigned, 0, signer)).rejects.toThrow(
      /does not verify/,
    )
  })
})

describe('toP256FrameAccount', () => {
  test('prepares and signs scheme-2 entry zero for a delegated EOA', async () => {
    const signer = privateKeyToP256Account(PRIVATE_KEY)
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toP256FrameAccount({
      client,
      address: DELEGATED_EOA,
      owner: signer,
    })
    const entries = await account.getSignatureEntries(GOLDEN_TX)
    const unsigned = {
      ...GOLDEN_TX,
      sender: DELEGATED_EOA,
      signatures: [...entries],
    }
    const signed = await account.signFrameTransaction(unsigned)

    expect(account.address).toBe(DELEGATED_EOA)
    expect(account.owner).toBe(signer)
    expect(signed.signatures[0]).toMatchObject({
      scheme: 2,
      signer: signer.address,
      msg: '0x',
    })
    expect(signed.signatures[0]!.signature).toBe(
      concatHex([
        sliceHex(signed.signatures[0]!.signature, 0, 64),
        sliceHex(signer.publicKey, 1),
      ]),
    )
  })

  test('rejects a transaction for a different sender', async () => {
    const signer = privateKeyToP256Account(PRIVATE_KEY)
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toP256FrameAccount({
      client,
      address: DELEGATED_EOA,
      owner: signer,
    })

    await expect(account.signFrameTransaction(GOLDEN_TX)).rejects.toThrow(
      FrameEncodeError,
    )
  })
})
