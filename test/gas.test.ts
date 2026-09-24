import { describe, expect, test } from 'vitest'
import { frameTxGas, frameTxMaxCost, nonceCalldata } from '../src/gas.js'
import { GOLDEN_TX } from './fixtures/golden.js'

// Hand derivation for the golden vector. Billed fields, at 4 gas per zero byte
// and 16 per non-zero byte:
//   frame 0 data 0x1122                      2 bytes   2 non-zero        32
//   frame 1 data (empty)                     0 bytes                      0
//   signer 0x…abcd                          20 bytes  18 zero, 2 non-zero 104
//   msg (empty)                              0 bytes                      0
//   signature 0x01 * 65                     65 bytes  65 non-zero      1040
//   nonce calldata rlp([0]) || rlp(7) = c180 07  3 bytes  3 non-zero     48
//   total                                   90 bytes                   1224
// mandatory = 12000 + 2 * 475 + 2800 (SECP256K1)                      15750
// execution limits = 0x5208 + 0x9c40 = 21000 + 40000                  61000
describe('frameTxGas on the golden vector', () => {
  const gas = frameTxGas(GOLDEN_TX, 'chain')

  test('mandatory gas', () => expect(gas.mandatoryGas).toBe(15_750n))
  test('billed byte count', () => expect(gas.billedBytes).toBe(90n))
  test('data cost', () => expect(gas.dataCost).toBe(1_224n))
  test('intrinsic gas', () => expect(gas.intrinsicGas).toBe(16_974n))
  test('state gas limit', () => expect(gas.stateGasLimit).toBe(0n))
  // 16974 + 61000 + 0
  test('standard gas limit', () => expect(gas.standardGasLimit).toBe(77_974n))
  // 90 * 4
  test('calldata tokens', () => expect(gas.calldataTokens).toBe(360n))
  // 15750 + 360 * 16
  test('calldata floor total', () => expect(gas.calldataFloorTotal).toBe(21_510n))
  test('max gas takes the standard branch', () => expect(gas.maxGas).toBe(77_974n))
})

describe('EIP-8250 nonce calldata', () => {
  test('is rlp(nonce_keys) || rlp(nonce_seq)', () => {
    expect(nonceCalldata(GOLDEN_TX)).toBe('0xc18007')
  })

  test('is billed for a keyed nonce at the calldata rate', () => {
    // rlp([1, 2**255]) = e2 01 a0 80 00*31 (35 bytes), rlp(7) = 07: 36 bytes,
    // 31 of them zero. 5 * 16 + 31 * 4 = 204, against 48 for the golden `[0]`.
    const keyed = { ...GOLDEN_TX, nonceKeys: [1n, 2n ** 255n] }
    expect(frameTxGas(keyed, 'chain').billedBytes).toBe(90n - 3n + 36n)
    expect(frameTxGas(keyed, 'chain').dataCost).toBe(1_224n - 48n + 204n)
  })
})

describe('frameTxMaxCost', () => {
  test('is maxGas * maxFeePerGas with no blobs', () => {
    // 77974 * 0x6fc23ac00 (30 gwei)
    expect(frameTxMaxCost(GOLDEN_TX, 0n, 'chain')).toBe(2_339_220_000_000_000n)
  })

  test('adds the blob term at the base rate', () => {
    const tx = { ...GOLDEN_TX, blobVersionedHashes: [`0x${'ab'.repeat(32)}` as const] }
    const gas = frameTxGas(tx, 'chain')
    expect(frameTxMaxCost(tx, 7n, 'chain')).toBe(
      gas.maxGas * tx.maxFeePerGas + 131_072n * 7n,
    )
  })
})

describe('the calldata floor branch', () => {
  test('binds when declared execution gas is small relative to data', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, limits: { execution: 1n, state: 0n },
          data: `0x${'ff'.repeat(2000)}` as const },
      ],
      signatures: [],
    }
    const gas = frameTxGas(tx, 'chain')
    expect(gas.maxGas).toBe(gas.calldataFloorTotal + gas.stateGasLimit)
    expect(gas.maxGas).toBeGreaterThan(gas.standardGasLimit)
  })

  test('state gas is added on top of the floor, never absorbed by it', () => {
    const base = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, limits: { execution: 1n, state: 0n },
          data: `0x${'ff'.repeat(2000)}` as const },
      ],
      signatures: [],
    }
    const withState = {
      ...base,
      frames: [{ ...base.frames[0]!, limits: { execution: 1n, state: 50_000n } }],
    }
    expect(frameTxGas(withState, 'chain').maxGas).toBe(
      frameTxGas(base, 'chain').maxGas + 50_000n,
    )
  })
})

describe('signature verification cost by scheme', () => {
  // EIP-8141 Constants table (DESIGN.md §4): ARBITRARY 100, SECP256K1 2800,
  // P256 6700. Hand-written figures, not read back from SIG_VERIFY_COST. No
  // captured fixture carries a scheme-0 or scheme-2 entry.
  const withSchemes = (schemes: (0 | 1 | 2)[]) => ({
    ...GOLDEN_TX,
    signatures: schemes.map((scheme) => ({
      scheme,
      signer: null,
      msg: '0x' as const,
      signature:
        scheme === 1
          ? (`0x${'11'.repeat(65)}` as const)
          : scheme === 2
            ? (`0x${'11'.repeat(128)}` as const)
            : ('0xdeadbeef' as const),
    })),
  })

  test('an ARBITRARY entry adds 100', () => {
    expect(frameTxGas(withSchemes([0]), 'chain').signatureVerificationCost).toBe(100n)
  })

  test('a SECP256K1 entry adds 2800', () => {
    expect(frameTxGas(withSchemes([1]), 'chain').signatureVerificationCost).toBe(2_800n)
  })

  test('a P256 entry adds 6700', () => {
    expect(frameTxGas(withSchemes([2]), 'chain').signatureVerificationCost).toBe(6_700n)
  })

  test('the cost is the sum across a mixed list', () => {
    expect(
      frameTxGas(withSchemes([1, 2, 0]), 'chain').signatureVerificationCost,
    ).toBe(2_800n + 6_700n + 100n)
  })

  test('it feeds mandatoryGas: 12000 + 475*len(frames) + sig cost', () => {
    // Golden has two frames; a lone P256 entry -> 12000 + 950 + 6700.
    expect(frameTxGas(withSchemes([2]), 'chain').mandatoryGas).toBe(
      12_000n + 475n * 2n + 6_700n,
    )
  })
})

describe('rule sets', () => {
  test('compatibility rule-set names price identically', () => {
    expect(frameTxGas(GOLDEN_TX, 'chain')).toEqual(frameTxGas(GOLDEN_TX, 'pins'))
    expect(frameTxGas(GOLDEN_TX, 'head')).toEqual(frameTxGas(GOLDEN_TX, 'pins'))
  })
})
