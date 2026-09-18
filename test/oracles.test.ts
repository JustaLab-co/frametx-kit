import { describe, expect, test } from 'vitest'
import { decodeFrameTx, encodeFrameTx } from '../src/envelope.js'
import { frameTxSigHash } from '../src/sighash.js'
import {
  GOLDEN_RLP,
  GOLDEN_SIG_HASH,
  GOLDEN_TX,
} from './fixtures/golden.js'

describe('Ethrex v23 wire oracle', () => {
  test('encodes the seven-field transaction byte-for-byte', () => {
    expect(encodeFrameTx(GOLDEN_TX)).toBe(GOLDEN_RLP)
  })

  test('decodes the exact bytes without a dialect transform', () => {
    expect(decodeFrameTx(GOLDEN_RLP)).toEqual(GOLDEN_TX)
  })

  test('reproduces the canonical signature hash', () => {
    expect(frameTxSigHash(GOLDEN_TX)).toBe(GOLDEN_SIG_HASH)
  })
})
