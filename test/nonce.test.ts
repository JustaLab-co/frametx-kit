import { describe, expect, test } from 'vitest'
import { FrameEncodeError } from '../src/errors.js'
import { NONCE_MANAGER, keyedNonceSlot } from '../src/nonce.js'

// Expected slots computed with foundry's `cast keccak` over
// left_pad_32(sender) || uint256_to_bytes32(key), not with this library.
describe('keyedNonceSlot', () => {
  test('matches the EIP-8250 slot for key 1', () => {
    expect(keyedNonceSlot('0x23d3957be879aba6ca925ee4f072d1a8c4e8c890', 1n)).toBe(
      '0x44b4c2b272c094a086fba3d2855ee62a9a7fe342d92cc698147066d6735b79da',
    )
  })

  test('is case-insensitive in the sender', () => {
    expect(keyedNonceSlot('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A', 5n)).toBe(
      keyedNonceSlot('0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', 5n),
    )
  })

  test('refuses key 0, which is the account nonce and has no slot', () => {
    expect(() => keyedNonceSlot(NONCE_MANAGER, 0n)).toThrow(FrameEncodeError)
  })

  test('refuses a key wider than 256 bits', () => {
    expect(() => keyedNonceSlot(NONCE_MANAGER, 2n ** 256n)).toThrow(FrameEncodeError)
  })
})
