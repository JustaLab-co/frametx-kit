import { describe, expect, test } from 'vitest'
import { decodeFrameTx, encodeFrameTx, encodeFrameTxBody } from '../src/envelope.js'
import { GOLDEN_RLP, GOLDEN_TX } from './fixtures/golden.js'

describe('encodeFrameTx', () => {
  test('reproduces the golden vector byte-for-byte', () => {
    expect(encodeFrameTx(GOLDEN_TX)).toBe(GOLDEN_RLP)
  })

  test('encodes nonceSeq zero as an empty RLP string, not 0x00', () => {
    const encoded = encodeFrameTx({ ...GOLDEN_TX, nonceSeq: 0n })
    expect(encoded).not.toBe(GOLDEN_RLP)
    // chainId 1, nonceKeys [0] as `c1 80`, nonceSeq 0 as `80`, then the sender.
    expect(encoded.slice(0, 18)).toBe('0x06f8b201c1808094')
  })

  test('encodes nonceKeys as a list of minimal uint256 scalars', () => {
    const encoded = encodeFrameTx({ ...GOLDEN_TX, nonceKeys: [1n, 2n ** 255n] })
    // `e2` lists 34 bytes: `01`, then `a0` and the 32-byte key; `07` is nonceSeq.
    expect(encoded).toContain(`01e201a080${'00'.repeat(31)}07`)
  })

  test('a targetless frame encodes an empty target, not 20 zero bytes', () => {
    const encoded = encodeFrameTx(GOLDEN_TX)
    expect(encoded).toContain('cc010380c48252088080')
  })

  test('encodeFrameTxBody is the wire encoding minus the 0x06 type byte', () => {
    expect(encodeFrameTx(GOLDEN_TX)).toBe(`0x06${encodeFrameTxBody(GOLDEN_TX).slice(2)}`)
  })

  test('limits always encode as a two-element list, even with zero state', () => {
    // c4 (825208)(80): the golden VERIFY frame's state limit is zero.
    expect(encodeFrameTx(GOLDEN_TX)).toContain('c482520880')
  })

  test('the fees list always has three entries, even when maxFeePerBlobGas is zero', () => {
    // cc (843b9aca00)(8506fc23ac00)(80) — the trailing 80 is the zero blob fee
    expect(encodeFrameTx(GOLDEN_TX)).toContain('cc843b9aca008506fc23ac0080')
  })

  test('an empty blob list is the final 0xc0 field', () => {
    expect(encodeFrameTx(GOLDEN_TX).endsWith('c0')).toBe(true)
  })
})

// Scheme 2 has no captured fixture and no golden vector, so its wire shape is
// otherwise unpinned. A 128-byte signature crosses the RLP short/long-string
// boundary (>55 bytes), so it must encode as `b8 80 <128 bytes>`.
describe('encodeFrameTx: P256 signature entry', () => {
  // A distinguishable 32-byte `msg` so the field order is actually asserted:
  // with an empty signer and an empty msg both encoding as 0x80, the entry is
  // invariant under a signer/msg swap.
  const MSG = `0x${'ab'.repeat(32)}` as const
  const p256Tx = {
    ...GOLDEN_TX,
    signatures: [
      {
        scheme: 2 as const,
        signer: null,
        msg: MSG,
        signature: `0x${'2b'.repeat(128)}` as const,
      },
    ],
  }

  test('a 128-byte signature encodes as an RLP long string, b8 80 ...', () => {
    expect(encodeFrameTx(p256Tx)).toContain(`b880${'2b'.repeat(128)}`)
  })

  test('the entry is scheme, empty signer, msg, signature in that order', () => {
    // 02 (scheme) | 80 (empty signer) | a0 <32-byte msg> | b8 80 <128-byte sig>
    expect(encodeFrameTx(p256Tx)).toContain(
      `0280a0${'ab'.repeat(32)}b880${'2b'.repeat(128)}`,
    )
  })

  test('round-trips through decodeFrameTx', () => {
    expect(decodeFrameTx(encodeFrameTx(p256Tx))).toEqual(p256Tx)
  })
})
