import {
  type Account,
  type Address,
  type Hex,
  isAddressEqual,
  recoverAddress,
} from 'viem'
import { sameAddress } from '../envelope.js'
import { FrameEncodeError } from '../errors.js'
import type { FrameSignature, FrameTransaction } from '../types.js'
import type { FrameAccountOwner } from './types.js'

export type RawFrameSigner = (parameters: { hash: Hex }) => Promise<Hex>

export function ownerWithSigner(
  owner: FrameAccountOwner,
  sign?: RawFrameSigner | undefined,
): FrameAccountOwner {
  if (sign === undefined) return owner
  if (owner.type === 'p256') return { ...owner, sign }
  return {
    ...owner,
    async sign({ hash }: { hash: Hex }) {
      const signature = await sign({ hash })
      let recovered: Address
      try {
        recovered = await recoverAddress({ hash, signature })
      } catch {
        throw new FrameEncodeError(
          `raw signer for ${owner.address} returned an invalid secp256k1 signature`,
        )
      }
      if (!isAddressEqual(recovered, owner.address))
        throw new FrameEncodeError(
          `raw signer recovered ${recovered}, expected owner ${owner.address}`,
        )
      return signature
    },
  } as Account
}

export function ownerSignatureScheme(owner: FrameAccountOwner): 1 | 2 {
  return owner.type === 'p256' ? 2 : 1
}

export function ownerSignatureEntry(
  owner: FrameAccountOwner,
  signer: Address | null,
): FrameSignature {
  return {
    scheme: ownerSignatureScheme(owner),
    signer,
    msg: '0x',
    signature: '0x',
  }
}

export function findOwnerSignatureIndex(
  transaction: FrameTransaction,
  owner: FrameAccountOwner,
  direction: 'first' | 'last',
  options: { explicitSigner?: boolean } = {},
): number {
  const scheme = ownerSignatureScheme(owner)
  const matches = (signature: FrameSignature): boolean =>
    (!options.explicitSigner || signature.signer !== null) &&
    signature.scheme === scheme &&
    signature.msg === '0x' &&
    sameAddress(signature.signer ?? transaction.sender, owner.address)

  if (direction === 'first') return transaction.signatures.findIndex(matches)
  for (let index = transaction.signatures.length - 1; index >= 0; index--)
    if (matches(transaction.signatures[index]!)) return index
  return -1
}
