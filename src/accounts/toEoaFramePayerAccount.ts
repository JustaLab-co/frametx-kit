import {
  type Account,
  type Address,
  type Hash,
  type Hex,
  isAddressEqual,
} from 'viem'
import { FrameEncodeError } from '../errors.js'
import { signFrameSignature } from '../signatures.js'
import type { FrameTransaction } from '../types.js'
import { toFramePayerAccount } from './toFramePayerAccount.js'
import type {
  FramePayerAccount,
  FramePayerAccountImplementation,
} from './types.js'

export type EoaFramePayerOwner = Account & {
  address: Address
  sign: (parameters: { hash: Hash }) => Promise<Hex>
}

export type EoaFramePayerAccountImplementation<
  owner extends EoaFramePayerOwner = EoaFramePayerOwner,
  extend extends object = object,
> = FramePayerAccountImplementation<owner, extend>

export type ToEoaFramePayerAccountParameters<
  owner extends EoaFramePayerOwner = EoaFramePayerOwner,
  extend extends object = object,
> = {
  owner: owner
  extend?: extend | undefined
}

export type ToEoaFramePayerAccountReturnType<
  owner extends EoaFramePayerOwner = EoaFramePayerOwner,
  extend extends object = object,
> = FramePayerAccount<EoaFramePayerAccountImplementation<owner, extend>>

/** Create a frame payer backed by the protocol's codeless EOA default code. */
export function toEoaFramePayerAccount<
  owner extends EoaFramePayerOwner,
  extend extends object = object,
>(
  parameters: ToEoaFramePayerAccountParameters<owner, extend>,
): Promise<ToEoaFramePayerAccountReturnType<owner, extend>> {
  const { owner } = parameters

  function assertPayFrame(transaction: FrameTransaction): void {
    const hasPayFrame = transaction.frames.some(
      (frame) =>
        frame.mode === 1 &&
        frame.flags === 0x1 &&
        frame.target !== null &&
        isAddressEqual(frame.target, owner.address),
    )
    if (!hasPayFrame)
      throw new FrameEncodeError(
        `transaction has no payment-only VERIFY frame targeting EOA payer ${owner.address}`,
      )
  }

  return toFramePayerAccount({
    owner,
    ...(parameters.extend === undefined ? {} : { extend: parameters.extend }),
    async getAddress() {
      return owner.address
    },
    async getPayData() {
      return '0x'
    },
    async getSignatureEntries(transaction) {
      assertPayFrame(transaction)
      if (transaction.signatures.length !== 1)
        throw new FrameEncodeError(
          `codeless EOA payer signature must be inserted at index 1; found ${transaction.signatures.length} existing entries`,
        )

      return [
        {
          scheme: 1,
          signer: owner.address,
          msg: '0x',
          signature: '0x',
        },
      ]
    },
    async signFrameTransaction(transaction: FrameTransaction) {
      assertPayFrame(transaction)
      const signature = transaction.signatures[1]
      if (signature === undefined)
        throw new FrameEncodeError('codeless EOA payer requires signature index 1')
      if (signature.signer === null || !isAddressEqual(signature.signer, owner.address))
        throw new FrameEncodeError(
          `signature 1 signer must match EOA payer ${owner.address}`,
        )

      return signFrameSignature(transaction, 1, owner)
    },
  })
}
