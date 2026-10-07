import {
  type Address,
  type Hex,
  concatHex,
  getAddress,
  keccak256,
  numberToHex,
  size,
  sliceHex,
} from 'viem'
import * as P256 from 'ox/P256'
import { FrameEncodeError } from './errors.js'

export type P256FrameSigner = {
  type: 'p256'
  /** `last20Bytes(keccak256(qx || qy))`. */
  address: Address
  /** Uncompressed SEC1 public key encoded as `0x04 || qx || qy`. */
  publicKey: Hex
  /** Sign an already-hashed 32-byte digest as `r || s` without hashing it again. */
  sign: (parameters: { hash: Hex }) => Promise<Hex>
}

function assertBytes32(value: Hex, label: string): void {
  if (size(value) !== 32)
    throw new FrameEncodeError(`${label} must be exactly 32 bytes`)
}

function oxPublicKey(publicKey: Hex) {
  if (size(publicKey) !== 65 || sliceHex(publicKey, 0, 1) !== '0x04')
    throw new FrameEncodeError(
      'P-256 public key must be 65-byte uncompressed SEC1 data (0x04 || qx || qy)',
    )
  const qx = sliceHex(publicKey, 1, 33)
  const qy = sliceHex(publicKey, 33, 65)
  const value = {
    prefix: 4 as const,
    x: BigInt(qx),
    y: BigInt(qy),
  }

  try {
    P256.noble.ProjectivePoint.fromHex(publicKey.slice(2))
  } catch {
    throw new FrameEncodeError('P-256 public key is not a point on the curve')
  }
  return value
}

/** Derive the EIP-8141 P-256 signer identity from an uncompressed public key. */
export function p256SignerIdentity(publicKey: Hex): Address {
  oxPublicKey(publicKey)
  return getAddress(sliceHex(keccak256(sliceHex(publicKey, 1)), 12))
}

/** Create a raw-digest P-256 signer from a 32-byte private scalar. */
export function privateKeyToP256Account(privateKey: Hex): P256FrameSigner {
  assertBytes32(privateKey, 'P-256 private key')

  let point: ReturnType<typeof P256.getPublicKey>
  try {
    point = P256.getPublicKey({ privateKey })
  } catch {
    throw new FrameEncodeError('P-256 private key is not a valid scalar')
  }

  const publicKey = concatHex([
    '0x04',
    numberToHex(point.x, { size: 32 }),
    numberToHex(point.y, { size: 32 }),
  ])

  return {
    type: 'p256',
    address: p256SignerIdentity(publicKey),
    publicKey,
    async sign({ hash }) {
      assertBytes32(hash, 'P-256 signing hash')
      // The frame sig-hash is already a digest. `hash` is deliberately omitted,
      // otherwise Ox would SHA-256 it again before ECDSA signing.
      const { r, s } = P256.sign({
        payload: hash,
        privateKey,
        extraEntropy: false,
      })
      return concatHex([
        numberToHex(r, { size: 32 }),
        numberToHex(s, { size: 32 }),
      ])
    },
  }
}
