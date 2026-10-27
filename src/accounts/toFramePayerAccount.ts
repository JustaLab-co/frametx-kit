import { type Address, isAddressEqual } from 'viem'
import { FrameEncodeError } from '../errors.js'
import { signFrameSignature } from '../signatures.js'
import type { FrameTransaction } from '../types.js'
import {
  findOwnerSignatureIndex,
  ownerSignatureEntry,
  ownerWithSigner,
  type RawFrameSigner,
} from './defaults.js'
import type {
  FrameAccountOwner,
  FramePayerAccount,
  FramePayerAccountImplementation,
} from './types.js'

export type ToFramePayerAccountParameters<
  owner extends FrameAccountOwner = FrameAccountOwner,
  extend extends object = object,
> = {
  owner: owner
  /** Payer address. Defaults to `owner.address`. */
  address?: Address | undefined
  /** Expected EIP-7702 delegate. Omit for a non-delegated payer. */
  delegateAddress?: Address | undefined
  /** Raw-digest signer override, primarily for injected or remote accounts. */
  sign?: RawFrameSigner | undefined
  extend?: extend | undefined
  getAddress?: (() => Promise<Address>) | undefined
  getPayData?: FramePayerAccountImplementation<owner, extend>['getPayData'] | undefined
  getSignatureEntries?:
    | FramePayerAccountImplementation<owner, extend>['getSignatureEntries']
    | undefined
  signFrameTransaction?:
    | ((transaction: FrameTransaction) => Promise<FrameTransaction>)
    | undefined
}

export type ToFramePayerAccountReturnType<
  owner extends FrameAccountOwner = FrameAccountOwner,
  extend extends object = object,
> = FramePayerAccount<FramePayerAccountImplementation<owner, extend>>

/** Create a payer account with overridable defaults for common payment policies. */
export async function toFramePayerAccount<
  owner extends FrameAccountOwner,
  extend extends object = object,
>(
  parameters: ToFramePayerAccountParameters<owner, extend>,
): Promise<ToFramePayerAccountReturnType<owner, extend>> {
  const { owner } = parameters
  const getAddress =
    parameters.getAddress ?? (async () => parameters.address ?? owner.address)
  const signingOwner = ownerWithSigner(owner, parameters.sign)

  async function assertPayFrame(transaction: FrameTransaction): Promise<void> {
    const payer = await getAddress()
    const hasPayFrame = transaction.frames.some(
      (frame) =>
        frame.mode === 1 &&
        frame.flags === 0x1 &&
        frame.target !== null &&
        isAddressEqual(frame.target, payer),
    )
    if (!hasPayFrame)
      throw new FrameEncodeError(
        `transaction has no payment-only VERIFY frame targeting payer ${payer}`,
      )
  }

  const getPayData = parameters.getPayData ?? (async () => '0x' as const)

  const getSignatureEntries =
    parameters.getSignatureEntries ??
    (async (transaction: FrameTransaction) => {
      await assertPayFrame(transaction)
      return [ownerSignatureEntry(owner, owner.address)]
    })

  const signFrameTransaction =
    parameters.signFrameTransaction ??
    (async (transaction: FrameTransaction) => {
      await assertPayFrame(transaction)

      let prepared = transaction
      let signatureIndex = findOwnerSignatureIndex(prepared, owner, 'last')
      if (signatureIndex === -1) {
        const entries = await getSignatureEntries(transaction)
        prepared = {
          ...transaction,
          signatures: [...transaction.signatures, ...entries],
        }
        signatureIndex = findOwnerSignatureIndex(prepared, owner, 'last')
      }
      if (signatureIndex === -1)
        throw new FrameEncodeError(
          `frame payer ${await getAddress()} has no signable entry for owner ${owner.address}`,
        )

      return signFrameSignature(prepared, signatureIndex, signingOwner)
    })

  const { extend, sign: _sign, address: _address, ...rest } = parameters
  const address = await getAddress()
  return {
    ...extend,
    ...rest,
    owner,
    getAddress,
    getPayData,
    getSignatureEntries,
    signFrameTransaction,
    address,
    type: 'framePayer',
  } as ToFramePayerAccountReturnType<owner, extend>
}
