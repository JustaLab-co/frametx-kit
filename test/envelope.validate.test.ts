import { describe, expect, test } from 'vitest'
import { EXPIRY_VERIFIER, validateFrameTx } from '../src/envelope.js'
import { FrameEncodeError } from '../src/errors.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const VERIFY_FRAME = GOLDEN_TX.frames[0]! // mode 1, flags 3, no target
const SENDER_FRAME = GOLDEN_TX.frames[1]! // mode 2, flags 0, target 0x…1234

describe('validateFrameTx', () => {
  test('accepts the golden transaction', () => {
    expect(() => validateFrameTx(GOLDEN_TX)).not.toThrow()
  })

  test('rejects the zero address as sender', () => {
    expect(() =>
      validateFrameTx({ ...GOLDEN_TX, sender: `0x${'00'.repeat(20)}` }),
    ).toThrow(/zero address/)
  })

  // `Address` is `0x${string}`, so a wrong-width address needs no cast to reach
  // the encoder, and viem's `toRlp` left-pads odd-length hex rather than
  // refusing it. `asAddressOrNull` rejects these widths on the decode side.
  test('rejects a sender that is not 20 bytes', () => {
    expect(() =>
      validateFrameTx({ ...GOLDEN_TX, sender: `0x${'aa'.repeat(19)}` }),
    ).toThrow(/sender must be 20 bytes, got 19/)
  })

  test('rejects a signature signer that is not 20 bytes', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, signer: `0x${'aa'.repeat(21)}` as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/signature 0: signer must be 20 bytes, got 21/)
  })

  test('rejects a frame target that is not 20 bytes', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [{ ...SENDER_FRAME, target: `0x${'bb'.repeat(21)}` as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/frame 0: target must be 20 bytes, got 21/)
  })

  test('rejects an address field that is not byte-aligned', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [{ ...SENDER_FRAME, target: '0xabc' as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/not byte-aligned/)
  })

  test('rejects value on a non-SENDER frame', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, value: 1n }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/only SENDER frames/)
  })

  test('rejects reserved flag bits', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x08 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/reserved/)
  })

  test('rejects nonceSeq at 2**64 - 1', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceSeq: 2n ** 64n - 1n })).toThrow(
      /nonceSeq must be below/,
    )
  })

  test('accepts nonceSeq at 2**64 - 2', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceSeq: 2n ** 64n - 2n })).not.toThrow()
  })

  test('rejects more than 64 frames', () => {
    const frames = Array.from({ length: 65 }, () => SENDER_FRAME)
    expect(() => validateFrameTx({ ...GOLDEN_TX, frames })).toThrow(/at most 64/)
  })

  test('rejects an empty frames list', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, frames: [] })).toThrow(/at least one frame/)
  })

  test('rejects a non-null signer on an ARBITRARY signature', () => {
    const tx = { ...GOLDEN_TX, signatures: [{ ...GOLDEN_TX.signatures[0]!, scheme: 0 as const }] }
    expect(() => validateFrameTx(tx)).toThrow(/ARBITRARY/)
  })

  test('rejects a msg that is neither empty nor 32 bytes', () => {
    const tx = { ...GOLDEN_TX, signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: '0x1122' as const }] }
    expect(() => validateFrameTx(tx)).toThrow(/32 bytes/)
  })

  test('rejects an all-zero explicit msg', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: `0x${'00'.repeat(32)}` as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/zero digest/)
  })

  test('rejects a blob fee when there are no blobs', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, maxFeePerBlobGas: 1n })).toThrow(/no blobs/)
  })

  test('rejects a blob hash without the KZG version byte', () => {
    const tx = { ...GOLDEN_TX, blobVersionedHashes: [`0x02${'ab'.repeat(31)}` as const] }
    expect(() => validateFrameTx(tx)).toThrow(/version byte/)
  })

  test('rejects APPROVE_EXECUTION on a frame targeting a third party', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [
        { ...VERIFY_FRAME, target: '0x0000000000000000000000000000000000009999' as const },
        SENDER_FRAME,
      ],
    }
    expect(() => validateFrameTx(tx)).toThrow(/APPROVE_EXECUTION/)
  })

  test('rejects the atomic-batch flag on a VERIFY frame', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x7 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/atomic batch/)
  })

  test('rejects the atomic-batch flag on the last frame', () => {
    const tx = { ...GOLDEN_TX, frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }] }
    expect(() => validateFrameTx(tx)).toThrow(/last frame/)
  })

  test('rejects a scope approval inside an atomic batch', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }, { ...SENDER_FRAME, flags: 0x1 }],
    }
    expect(() => validateFrameTx(tx)).toThrow(/approve a scope/)
  })

  test('accepts a well-formed atomic batch', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [VERIFY_FRAME, { ...SENDER_FRAME, flags: 0x4 }, SENDER_FRAME],
    }
    expect(() => validateFrameTx(tx)).not.toThrow()
  })

  test('rejects an expiry-verifier frame with the wrong data length', () => {
    const expiry = { ...VERIFY_FRAME, flags: 0, target: EXPIRY_VERIFIER, data: '0x1122' as const }
    const tx = { ...GOLDEN_TX, frames: [expiry, VERIFY_FRAME, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/8 bytes/)
  })
})

describe('validateFrameTx: single-byte and 32-byte wire fields', () => {
  // ethrex decodes `flags` as u64 then `u8::try_from`, rejecting with
  // "Frame flags too large". Bit 8 clears the reserved-bits mask (0xf8) but
  // the encoder would emit a two-byte scalar for a field the chain reads as one.
  test('rejects flags that do not fit in one byte', () => {
    const tx = { ...GOLDEN_TX, frames: [{ ...VERIFY_FRAME, flags: 0x100 }, SENDER_FRAME] }
    expect(() => validateFrameTx(tx)).toThrow(/flags.*one byte/)
  })

})

/**
 * ethrex's `FrameTransaction` decodes each numeric field at a fixed width —
 * `chain_id` and `nonce_seq` as u64; the nonce keys, all three fees and
 * `Frame::value` as U256.
 * `static_left_pad` returns `InvalidLength`
 * for anything wider. A wider value encodes to well-formed RLP here and then
 * cannot be decoded by the node at all, so it has to be caught on this side.
 */
describe('validateFrameTx: numeric field widths', () => {
  const U64_MAX = 2n ** 64n - 1n
  const U256_MAX = 2n ** 256n - 1n
  test('accepts chainId at 2**64 - 1', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, chainId: U64_MAX })).not.toThrow()
  })

  test('rejects chainId at 2**64', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, chainId: 2n ** 64n })).toThrow(
      /chainId must fit in 64 bits/,
    )
  })

  test('accepts maxPriorityFeePerGas at 2**256 - 1', () => {
    expect(() =>
      validateFrameTx({ ...GOLDEN_TX, maxPriorityFeePerGas: U256_MAX }),
    ).not.toThrow()
  })

  test('rejects maxPriorityFeePerGas at 2**256', () => {
    expect(() =>
      validateFrameTx({ ...GOLDEN_TX, maxPriorityFeePerGas: 2n ** 256n }),
    ).toThrow(/maxPriorityFeePerGas must fit in 256 bits/)
  })

  test('accepts maxFeePerGas at 2**256 - 1', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, maxFeePerGas: U256_MAX })).not.toThrow()
  })

  test('rejects maxFeePerGas at 2**256', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, maxFeePerGas: 2n ** 256n })).toThrow(
      /maxFeePerGas must fit in 256 bits/,
    )
  })

  test('accepts a frame value at 2**256 - 1', () => {
    const tx = { ...GOLDEN_TX, frames: [VERIFY_FRAME, { ...SENDER_FRAME, value: U256_MAX }] }
    expect(() => validateFrameTx(tx)).not.toThrow()
  })

  test('rejects a frame value at 2**256', () => {
    const tx = { ...GOLDEN_TX, frames: [VERIFY_FRAME, { ...SENDER_FRAME, value: 2n ** 256n }] }
    expect(() => validateFrameTx(tx)).toThrow(/frame 1: value must fit in 256 bits/)
  })

  test('rejects maxFeePerBlobGas at 2**256', () => {
    const tx = {
      ...GOLDEN_TX,
      blobVersionedHashes: [`0x01${'ab'.repeat(31)}` as const],
      maxFeePerBlobGas: 2n ** 256n,
    }
    expect(() => validateFrameTx(tx)).toThrow(/maxFeePerBlobGas must fit in 256 bits/)
  })

  test('rejects a negative fee', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, maxFeePerGas: -1n })).toThrow(
      /maxFeePerGas must not be negative/,
    )
  })

  test('rejects a negative frame gas limit', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [VERIFY_FRAME, { ...SENDER_FRAME, limits: { execution: -1n, state: 0n } }],
    }
    expect(() => validateFrameTx(tx)).toThrow(
      /frame 1: limits.execution must not be negative/,
    )
  })
})

/**
 * Malformed hex in a wire field is an encode-side violation, so it must throw
 * `FrameEncodeError` and not the `FrameRlpError` that `byteLength` raises
 * internally — regardless of which field carries the defect.
 */
describe('validateFrameTx: malformed hex fields throw FrameEncodeError', () => {
  test('an odd-length signature msg', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [{ ...GOLDEN_TX.signatures[0]!, msg: '0x123' as const }],
    }
    expect(() => validateFrameTx(tx)).toThrow(FrameEncodeError)
    expect(() => validateFrameTx(tx)).toThrow(/signature 0: msg/)
  })

  test('an odd-length frame data field', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [{ ...VERIFY_FRAME, data: '0x123' as const }, SENDER_FRAME],
    }
    expect(() => validateFrameTx(tx)).toThrow(FrameEncodeError)
    expect(() => validateFrameTx(tx)).toThrow(/frame 0: data/)
  })

  test('an odd-length ARBITRARY signature', () => {
    const tx = {
      ...GOLDEN_TX,
      signatures: [
        { scheme: 0 as const, signer: null, msg: '0x' as const, signature: '0x123' as const },
      ],
    }
    expect(() => validateFrameTx(tx)).toThrow(FrameEncodeError)
    expect(() => validateFrameTx(tx)).toThrow(/signature 0: signature/)
  })

  test('an odd-length blob versioned hash', () => {
    const tx = {
      ...GOLDEN_TX,
      blobVersionedHashes: [`0x01${'ab'.repeat(31)}c` as const],
    }
    expect(() => validateFrameTx(tx)).toThrow(FrameEncodeError)
    expect(() => validateFrameTx(tx)).toThrow(/blob hash 0/)
  })
})

/** EIP-8250 keyed-nonce rules, from `validate_static_constraints` at ethrex `bdfc5d8`. */
describe('validateFrameTx: nonce keys', () => {
  test('accepts the account nonce alone', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [0n] })).not.toThrow()
  })

  test('accepts strictly increasing non-zero keys', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [1n, 5n, 2n ** 256n - 1n] })).not.toThrow()
  })

  test('accepts sixteen keys', () => {
    const nonceKeys = Array.from({ length: 16 }, (_, i) => BigInt(i + 1))
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys })).not.toThrow()
  })

  test('rejects an empty key list', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [] })).toThrow(/between 1 and 16/)
  })

  test('rejects seventeen keys', () => {
    const nonceKeys = Array.from({ length: 17 }, (_, i) => BigInt(i + 1))
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys })).toThrow(/between 1 and 16/)
  })

  test('rejects a repeated key', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [3n, 3n] })).toThrow(
      /strictly increasing/,
    )
  })

  test('rejects decreasing keys', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [4n, 3n] })).toThrow(
      /strictly increasing/,
    )
  })

  test('rejects key 0 alongside another key', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [0n, 1n] })).toThrow(
      /key 0 is only valid as the sole nonce key/,
    )
  })

  test('rejects a key wider than 256 bits', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [2n ** 256n] })).toThrow(
      /nonceKeys\[0\] must fit in 256 bits/,
    )
  })

  test('checks the nonce before the frame count, as ethrex does', () => {
    expect(() => validateFrameTx({ ...GOLDEN_TX, nonceKeys: [], frames: [] })).toThrow(
      /nonceKeys/,
    )
  })
})
