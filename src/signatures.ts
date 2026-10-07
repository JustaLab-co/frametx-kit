import {
  type Account,
  type Address,
  type Hex,
  concatHex,
  numberToHex,
  recoverAddress,
  size,
  sliceHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as P256 from 'ox/P256'
import type { FrameAccountOwner } from './accounts/types.js'
import { sameAddress, validateFrameTx } from './envelope.js'
import { FrameEncodeError, FrameRlpError } from './errors.js'
import {
  type P256FrameSigner,
  p256SignerIdentity,
} from './p256.js'
import { byteLength } from './rlp.js'
import { frameTxSigHash } from './sighash.js'
import type { FrameSignature, FrameTransaction } from './types.js'

export const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const SECP256R1_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/**
 * Get byte length, converting RLP validation errors to encode errors.
 */
function signatureByteLength(sig: Hex, index: number): number {
  try {
    return byteLength(sig)
  } catch (err) {
    if (err instanceof FrameRlpError)
      throw new FrameEncodeError(`signature ${index}: ${err.message}`)
    throw err
  }
}

/**
 * EIP-8141 canonicality, checked at consensus in `validate_frame_signatures`
 * before any frame executes — a violation invalidates the whole transaction.
 *
 * Layout note: the field is `v || r || s`, with `v` at byte 0. That is the
 * REVERSE of Ethereum's usual `r || s || v`, and of what viem's
 * `signatureToHex` produces.
 */
export function assertCanonicalSignature(sig: FrameSignature, index: number): void {
  if (sig.scheme === 0) return // ARBITRARY carries no ECDSA scalars

  if (sig.scheme === 1) {
    const len = signatureByteLength(sig.signature, index)
    if (len !== 65)
      throw new FrameEncodeError(
        `signature ${index}: secp256k1 must be 65 bytes (v||r||s), got ${len}`,
      )
    const v = BigInt(sliceHex(sig.signature, 0, 1))
    const r = BigInt(sliceHex(sig.signature, 1, 33))
    const s = BigInt(sliceHex(sig.signature, 33, 65))
    if (v > 1n)
      throw new FrameEncodeError(
        `signature ${index}: v must be a bare recovery id (0 or 1), got ${v}`,
      )
    if (r === 0n || r >= SECP256K1_N)
      throw new FrameEncodeError(`signature ${index}: r must be in (0, n)`)
    if (s === 0n || s > SECP256K1_N / 2n)
      throw new FrameEncodeError(`signature ${index}: s must be low (0 < s <= n/2)`)
    return
  }

  const len = signatureByteLength(sig.signature, index)
  if (len !== 128)
    throw new FrameEncodeError(
      `signature ${index}: p256 must be 128 bytes (r||s||qx||qy), got ${len}`,
    )
  const r = BigInt(sliceHex(sig.signature, 0, 32))
  const s = BigInt(sliceHex(sig.signature, 32, 64))
  if (r === 0n || r >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: r must be in (0, n)`)
  if (s === 0n || s > SECP256R1_N / 2n)
    throw new FrameEncodeError(
      `signature ${index}: s must be low (0 < s <= n/2); P256VERIFY accepts high s, so normalize to n - s before signing`,
    )
}

/** An empty `signer` resolves to `tx.sender`, including for EVM introspection. */
export function resolveSigner(tx: FrameTransaction, index: number): Address {
  const sig = tx.signatures[index]
  if (sig === undefined) throw new FrameEncodeError(`no signature at index ${index}`)
  if (sig.scheme === 0)
    throw new FrameEncodeError(
      `signature ${index}: an ARBITRARY entry has no resolved signer`,
    )
  return sig.signer ?? tx.sender
}

/**
 * Recover the address that produced a SECP256K1 frame signature.
 *
 * `async` deliberately: the guard clauses below would otherwise throw
 * synchronously out of a function typed `Promise<Address>`, so a caller's
 * `.catch()` (or `rejects.toThrow`) would never see them.
 */
export async function recoverFrameSigner(
  tx: FrameTransaction,
  index: number,
): Promise<Address> {
  const sig = tx.signatures[index]
  if (sig === undefined) throw new FrameEncodeError(`no signature at index ${index}`)
  if (sig.scheme !== 1)
    throw new FrameEncodeError(
      `signature ${index}: recovery is only defined for secp256k1`,
    )
  assertCanonicalSignature(sig, index)

  const digest = sig.msg === '0x' ? frameTxSigHash(tx) : sig.msg
  const v = BigInt(sliceHex(sig.signature, 0, 1))
  const r = sliceHex(sig.signature, 1, 33)
  const s = sliceHex(sig.signature, 33, 65)

  // viem expects r||s||v with v as 27/28; the frame layout is v||r||s with a bare id.
  const viemSignature = `${r}${s.slice(2)}${(v + 27n).toString(16)}` as Hex
  return recoverAddress({ hash: digest, signature: viemSignature })
}

/**
 * Reduce whatever `v` a signer returned to the bare recovery id the frame layout
 * wants. viem returns 27/28; an HSM or a hand-rolled wrapper may return 0/1.
 *
 * Subtracting 27 unconditionally turns a bare id into a negative number and
 * writes `0x-1a…` into the signature — malformed hex that only trips the
 * byte-alignment check downstream, with a message that names the wrong problem.
 * An EIP-155 `v` is refused outright: it encodes a chain id this layout has no
 * room for, and guessing at its parity would forge a recovery id.
 */
function bareRecoveryId(v: bigint, index: number): bigint {
  if (v === 0n || v === 1n) return v
  if (v === 27n || v === 28n) return v - 27n
  throw new FrameEncodeError(
    `signature ${index}: signer returned v=${v}; expected a bare recovery id ` +
      `(0 or 1) or viem's 27/28. An EIP-155 v is not supported here — the frame ` +
      `layout carries a bare id and the chain id is a separate field.`,
  )
}

function resolveFrameSigner(signer: Hex | FrameAccountOwner): FrameAccountOwner {
  return typeof signer === 'string' ? privateKeyToAccount(signer) : signer
}

function signerScheme(signer: FrameAccountOwner): 1 | 2 {
  return signer.type === 'p256' ? 2 : 1
}

function schemeName(scheme: number): string {
  if (scheme === 1) return 'SECP256K1'
  if (scheme === 2) return 'P256'
  return 'ARBITRARY'
}

function assertSignerMatches(
  tx: FrameTransaction,
  index: number,
  signer: FrameAccountOwner,
): void {
  const resolvedSigner = resolveSigner(tx, index)
  if (!sameAddress(resolvedSigner, signer.address))
    throw new FrameEncodeError(
      `signature ${index}: resolved signer ${resolvedSigner} does not match ` +
        `the signing account ${signer.address}`,
    )
}

async function signSecp256k1Entry(
  tx: FrameTransaction,
  index: number,
  signer: Account,
  digest: Hex,
): Promise<FrameSignature> {
  if (typeof signer.sign !== 'function')
    throw new FrameEncodeError(
      `account ${signer.address} cannot sign a raw 32-byte digest: it has no ` +
        '`sign` method. A JSON-RPC account cannot sign one at all, and ' +
        '`signMessage` is not a substitute — it EIP-191-prefixes its argument.',
    )

  assertSignerMatches(tx, index, signer)
  const entry = tx.signatures[index]!
  const flat = await signer.sign({ hash: digest })
  const r = sliceHex(flat, 0, 32)
  const s = sliceHex(flat, 32, 64)
  const v = bareRecoveryId(BigInt(sliceHex(flat, 64, 65)), index)
  const signature = `0x${v.toString(16).padStart(2, '0')}${r.slice(2)}${s.slice(2)}` as Hex
  return { ...entry, signature }
}

async function signP256Entry(
  tx: FrameTransaction,
  index: number,
  signer: P256FrameSigner,
  digest: Hex,
): Promise<FrameSignature> {
  const derivedIdentity = p256SignerIdentity(signer.publicKey)
  if (!sameAddress(derivedIdentity, signer.address))
    throw new FrameEncodeError(
      `P-256 signer address ${signer.address} does not match public key identity ${derivedIdentity}`,
    )

  assertSignerMatches(tx, index, signer)
  const entry = tx.signatures[index]!
  const compactSignature = await signer.sign({ hash: digest })
  if (size(compactSignature) !== 64)
    throw new FrameEncodeError(
      `signature ${index}: P-256 signer must return exactly 64 bytes (r || s)`,
    )
  const r = BigInt(sliceHex(compactSignature, 0, 32))
  const returnedS = BigInt(sliceHex(compactSignature, 32, 64))
  if (r <= 0n || r >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: signer returned r outside (0, n)`)
  if (returnedS <= 0n || returnedS >= SECP256R1_N)
    throw new FrameEncodeError(`signature ${index}: signer returned s outside (0, n)`)

  const s = returnedS > SECP256R1_N / 2n ? SECP256R1_N - returnedS : returnedS
  const publicKey = {
    prefix: 4 as const,
    x: BigInt(sliceHex(signer.publicKey, 1, 33)),
    y: BigInt(sliceHex(signer.publicKey, 33, 65)),
  }
  if (!P256.verify({ payload: digest, publicKey, signature: { r, s } }))
    throw new FrameEncodeError(
      `signature ${index}: signer returned a signature that does not verify against its public key`,
    )

  return {
    ...entry,
    signature: concatHex([
      numberToHex(r, { size: 32 }),
      numberToHex(s, { size: 32 }),
      sliceHex(signer.publicKey, 1),
    ]),
  }
}

async function signFrameEntry(
  tx: FrameTransaction,
  index: number,
  signer: FrameAccountOwner,
  digest: Hex,
): Promise<FrameSignature> {
  const entry = tx.signatures[index]
  if (entry === undefined)
    throw new FrameEncodeError(`no signature at index ${index}`)
  if (entry.msg !== '0x' || entry.scheme === 0)
    throw new FrameEncodeError(
      `signature ${index}: slot signing requires SECP256K1 or P256 with an empty msg`,
    )

  const ownerScheme = signerScheme(signer)
  if (entry.scheme !== ownerScheme)
    throw new FrameEncodeError(
      `signature ${index}: ${schemeName(entry.scheme)} entry cannot be signed by ` +
        `a ${schemeName(ownerScheme)} owner`,
    )

  return ownerScheme === 2
    ? signP256Entry(tx, index, signer as P256FrameSigner, digest)
    : signSecp256k1Entry(tx, index, signer as Account, digest)
}

/** Sign one empty-message SECP256K1 or P256 entry. */
export async function signFrameSignature(
  tx: FrameTransaction,
  index: number,
  signer: Hex | FrameAccountOwner,
): Promise<FrameTransaction> {
  const account = resolveFrameSigner(signer)

  const entry = tx.signatures[index]
  if (entry === undefined)
    throw new FrameEncodeError(`no signature at index ${index}`)
  const signedEntry = await signFrameEntry(
    tx,
    index,
    account,
    frameTxSigHash(tx),
  )
  assertCanonicalSignature(signedEntry, index)

  const signatures = [...tx.signatures]
  signatures[index] = signedEntry
  return { ...tx, signatures }
}

/**
 * Sign every empty-`msg` SECP256K1 or P256 entry over the transaction's sig-hash.
 *
 * Takes either a raw private key or a `FrameAccountOwner`. A secp256k1 owner
 * must be a viem `Account`; a P-256 owner is created by
 * `privateKeyToP256Account` or implements the same interface.
 *
 * Idempotent: the sig-hash elides empty-`msg` signature bytes, so re-signing an
 * already-signed transaction produces the same bytes.
 */
export async function signFrameTx(
  tx: FrameTransaction,
  signer: Hex | FrameAccountOwner,
): Promise<FrameTransaction> {
  const account = resolveFrameSigner(signer)
  const digest = frameTxSigHash(tx)

  const signatures = await Promise.all(
    tx.signatures.map(async (sig, i) => {
      if (sig.scheme === 0 || sig.msg !== '0x') return sig
      return signFrameEntry(tx, i, account, digest)
    }),
  )

  const signed = { ...tx, signatures }
  signed.signatures.forEach((sig, i) => assertCanonicalSignature(sig, i))
  return signed
}

/**
 * Strict-encode entry point: run every consensus-checked validity rule before
 * any bytes are produced.
 *
 * `encodeFrameTx` itself does not call this — `frameTxSigHash` is defined over
 * a re-encoding of the (possibly signature-elided) transaction, so a validating
 * encoder would validate on every hash computed and on every re-encode of live
 * chain data in the survey suite, most of which is deliberately re-encoding
 * transactions this library did not construct. Call `assertValidFrameTx(tx)`
 * yourself before `encodeFrameTx(tx)` when building a transaction to relay.
 *
 * Every structural rule — field widths and the byte-alignment of every hex
 * field included — lives in `validateFrameTx`, so this adds exactly the one
 * thing that function cannot see: signature canonicality, which needs the
 * scheme-specific curve order.
 */
export function assertValidFrameTx(tx: FrameTransaction): void {
  validateFrameTx(tx)
  tx.signatures.forEach((sig, i) => assertCanonicalSignature(sig, i))
}
