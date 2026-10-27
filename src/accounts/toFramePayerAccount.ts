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

type FramePayerAccountBaseParameters<
  owner extends FrameAccountOwner | undefined,
  extend extends object = object,
> = {
  owner?: owner | undefined
  /** Payer address. Defaults to `owner.address`. */
  address?: Address | undefined
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

type DefaultFramePayerAccountParameters<
  owner extends FrameAccountOwner,
  extend extends object,
> = FramePayerAccountBaseParameters<owner, extend> & { owner: owner }

type CustomFramePayerAccountParameters<extend extends object> =
  FramePayerAccountBaseParameters<undefined, extend> & {
    owner?: undefined
    sign?: never
    getPayData: NonNullable<FramePayerAccountImplementation<undefined, extend>['getPayData']>
    getSignatureEntries: NonNullable<
      FramePayerAccountImplementation<undefined, extend>['getSignatureEntries']
    >
    signFrameTransaction: NonNullable<
      FramePayerAccountImplementation<undefined, extend>['signFrameTransaction']
    >
  } & (
    | { address: Address; getAddress?: undefined }
    | { address?: Address | undefined; getAddress: () => Promise<Address> }
  )

export type ToFramePayerAccountParameters<
  owner extends FrameAccountOwner | undefined = FrameAccountOwner,
  extend extends object = object,
> = owner extends FrameAccountOwner
  ? DefaultFramePayerAccountParameters<owner, extend>
  : CustomFramePayerAccountParameters<extend>

export type ToFramePayerAccountReturnType<
  owner extends FrameAccountOwner | undefined = FrameAccountOwner,
  extend extends object = object,
> = FramePayerAccount<FramePayerAccountImplementation<owner, extend>>

/** Create a payer account with overridable defaults for common payment policies. */
export async function toFramePayerAccount<
  owner extends FrameAccountOwner | undefined,
  extend extends object = object,
>(
  parameters: ToFramePayerAccountParameters<owner, extend>,
): Promise<ToFramePayerAccountReturnType<owner, extend>> {
  const { owner } = parameters
  if (parameters.address !== undefined && parameters.getAddress !== undefined)
    throw new FrameEncodeError(
      'frame payer parameters cannot include both address and getAddress',
    )
  const unresolvedAddress = parameters.address ?? owner?.address
  if (parameters.getAddress === undefined && unresolvedAddress === undefined)
    throw new FrameEncodeError(
      'ownerless frame payer requires address or getAddress',
    )
  const address = await (parameters.getAddress?.() ??
    Promise.resolve(unresolvedAddress!))
  const getAddress = async () => address

  if (owner === undefined) {
    if (
      parameters.getPayData === undefined ||
      parameters.getSignatureEntries === undefined ||
      parameters.signFrameTransaction === undefined
    )
      throw new FrameEncodeError(
        'ownerless frame payer requires getPayData, getSignatureEntries, and signFrameTransaction',
      )

    const { extend, address: _address, ...rest } = parameters
    return {
      ...extend,
      ...rest,
      owner,
      getAddress,
      getPayData: parameters.getPayData,
      getSignatureEntries: parameters.getSignatureEntries,
      signFrameTransaction: parameters.signFrameTransaction,
      address,
      type: 'framePayer',
    } as unknown as ToFramePayerAccountReturnType<owner, extend>
  }

  const signingOwner = ownerWithSigner(owner, parameters.sign)

  async function assertPayFrame(transaction: FrameTransaction): Promise<void> {
    if (isAddressEqual(transaction.sender, address))
      throw new FrameEncodeError(
        `default frame payer ${address} cannot also be the transaction sender`,
      )
    const hasPayFrame = transaction.frames.some(
      (frame) =>
        frame.mode === 1 &&
        frame.flags === 0x1 &&
        frame.target !== null &&
        isAddressEqual(frame.target, address),
    )
    if (!hasPayFrame)
      throw new FrameEncodeError(
        `transaction has no payment-only VERIFY frame targeting payer ${address}`,
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
      let signatureIndex = findOwnerSignatureIndex(prepared, owner, 'last', {
        explicitSigner: true,
      })
      if (signatureIndex === -1) {
        if (transaction.signatures.some((entry) => entry.signature !== '0x'))
          throw new FrameEncodeError(
            `frame payer ${address} has no entry and other entries are already signed; install payer entries during preparation`,
          )
        const entries = await getSignatureEntries(transaction)
        prepared = {
          ...transaction,
          signatures: [...transaction.signatures, ...entries],
        }
        signatureIndex = findOwnerSignatureIndex(prepared, owner, 'last', {
          explicitSigner: true,
        })
      }
      if (signatureIndex === -1)
        throw new FrameEncodeError(
          `frame payer ${address} has no signable entry for owner ${owner.address}`,
        )

      return signFrameSignature(prepared, signatureIndex, signingOwner)
    })

  const { extend, sign: _sign, address: _address, ...rest } = parameters
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
  } as unknown as ToFramePayerAccountReturnType<owner, extend>
}
