import {
  type Address,
  type Hex,
  concatHex,
  getAddress,
  isAddressEqual,
  keccak256,
  numberToHex,
  size,
  sliceHex,
} from 'viem'
import * as P256 from 'ox/P256'
import { sameAddress } from './envelope.js'
import { FrameEncodeError } from './errors.js'
import { frameTxSigHash } from './sighash.js'
import { SECP256R1_N, assertCanonicalSignature } from './signatures.js'
import type { FrameTransaction } from './types.js'

export type P256PublicKey = {
  qx: Hex
  qy: Hex
}

export type P256FrameSigner = {
  /** `last20Bytes(keccak256(qx || qy))`. */
  address: Address
  publicKey: P256PublicKey
  /** Sign an already-hashed 32-byte digest without hashing it again. */
  sign: (parameters: { hash: Hex }) => Promise<{ r: bigint; s: bigint }>
}

function assertBytes32(value: Hex, label: string): void {
  if (size(value) !== 32)
    throw new FrameEncodeError(`${label} must be exactly 32 bytes`)
}

function oxPublicKey(publicKey: P256PublicKey) {
  assertBytes32(publicKey.qx, 'P-256 qx')
  assertBytes32(publicKey.qy, 'P-256 qy')
  const value = {
    prefix: 4 as const,
    x: BigInt(publicKey.qx),
    y: BigInt(publicKey.qy),
  }

  try {
    P256.noble.ProjectivePoint.fromHex(
      concatHex(['0x04', publicKey.qx, publicKey.qy]).slice(2),
    )
  } catch {
    throw new FrameEncodeError('P-256 public key is not a point on the curve')
  }
  return value
}

/** Derive the EIP-8141 P-256 signer identity from its public coordinates. */
export function p256SignerIdentity(publicKey: P256PublicKey): Address {
  oxPublicKey(publicKey)
  return getAddress(sliceHex(keccak256(concatHex([publicKey.qx, publicKey.qy])), 12))
}

/** Create a raw-digest P-256 signer from a 32-byte private scalar. */
export function privateKeyToP256FrameSigner(privateKey: Hex): P256FrameSigner {
  assertBytes32(privateKey, 'P-256 private key')

  let point: ReturnType<typeof P256.getPublicKey>
  try {
    point = P256.getPublicKey({ privateKey })
  } catch {
    throw new FrameEncodeError('P-256 private key is not a valid scalar')
  }

  const publicKey = {
    qx: numberToHex(point.x, { size: 32 }),
    qy: numberToHex(point.y, { size: 32 }),
  } satisfies P256PublicKey

  return {
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
      return { r, s }
    },
  }
}

/** Sign one empty-message P-256 entry without changing any other signature. */
export async function signP256FrameSignature(
  transaction: FrameTransaction,
  index: number,
  signer: P256FrameSigner,
): Promise<FrameTransaction> {
  const entry = transaction.signatures[index]
  if (entry === undefined)
    throw new FrameEncodeError(`no signature at index ${index}`)
  if (entry.scheme !== 2 || entry.msg !== '0x')
    throw new FrameEncodeError(
      `signature ${index}: slot signing requires P256 with an empty msg`,
    )

  const derivedIdentity = p256SignerIdentity(signer.publicKey)
  if (!isAddressEqual(derivedIdentity, signer.address))
    throw new FrameEncodeError(
      `P-256 signer address ${signer.address} does not match public key identity ${derivedIdentity}`,
    )

  const resolvedSigner = entry.signer ?? transaction.sender
  if (!sameAddress(resolvedSigner, signer.address))
    throw new FrameEncodeError(
      `signature ${index}: resolved signer ${resolvedSigner} does not match ` +
        `the P-256 signer ${signer.address}`,
    )

  const hash = frameTxSigHash(transaction)
  const signed = await signer.sign({ hash })
  if (signed.r <= 0n || signed.r >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: signer returned r outside (0, n)`)
  if (signed.s <= 0n || signed.s >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: signer returned s outside (0, n)`)

  const s = signed.s > SECP256R1_N / 2n ? SECP256R1_N - signed.s : signed.s
  const publicKey = oxPublicKey(signer.publicKey)
  if (!P256.verify({ payload: hash, publicKey, signature: { r: signed.r, s } }))
    throw new FrameEncodeError(
      `signature ${index}: signer returned a signature that does not verify against its public key`,
    )

  const signature = concatHex([
    numberToHex(signed.r, { size: 32 }),
    numberToHex(s, { size: 32 }),
    signer.publicKey.qx,
    signer.publicKey.qy,
  ])
  const signedEntry = { ...entry, signature }
  assertCanonicalSignature(signedEntry, index)

  const signatures = [...transaction.signatures]
  signatures[index] = signedEntry
  return { ...transaction, signatures }
}
