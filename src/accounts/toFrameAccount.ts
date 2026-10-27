import {
  type Address,
  type Chain,
  type Client,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
  isAddressEqual,
} from 'viem'
import { FrameEncodeError } from '../errors.js'
import { getFrameNonceSeq } from '../nonce.js'
import { signFrameSignature } from '../signatures.js'
import type { FrameTransaction } from '../types.js'
import {
  findOwnerSignatureIndex,
  ownerSignatureEntry,
  ownerSignatureScheme,
  ownerWithSigner,
  type RawFrameSigner,
} from './defaults.js'
import type {
  DirectFrameExecution,
  FrameAccount,
  FrameAccountImplementation,
  FrameAccountOwner,
  GetFrameNonceParameters,
  GetValidationDataParameters,
} from './types.js'

export type ToFrameAccountParameters<
  chain extends Chain | undefined = Chain | undefined,
  owner extends FrameAccountOwner = FrameAccountOwner,
  extend extends object = object,
> = {
  client: Client<Transport, chain, JsonRpcAccount | LocalAccount | undefined>
  owner: owner
  /** Sender address. Defaults to `owner.address`. */
  address?: Address | undefined
  /** Expected EIP-7702 delegate. Omit for a non-delegated account. */
  delegateAddress?: Address | undefined
  /** Raw-digest signer override, primarily for injected or remote accounts. */
  sign?: RawFrameSigner | undefined
  execution?: DirectFrameExecution | undefined
  extend?: extend | undefined
  getAddress?: (() => Promise<Address>) | undefined
  getNonce?: ((parameters?: GetFrameNonceParameters) => Promise<bigint>) | undefined
  getValidationData?:
    | ((parameters: GetValidationDataParameters) => Promise<`0x${string}`>)
    | undefined
  getSignatureEntries?:
    | FrameAccountImplementation<chain, owner, extend>['getSignatureEntries']
    | undefined
  signFrameTransaction?:
    | ((transaction: FrameTransaction) => Promise<FrameTransaction>)
    | undefined
}

export type ToFrameAccountReturnType<
  chain extends Chain | undefined = Chain | undefined,
  owner extends FrameAccountOwner = FrameAccountOwner,
  extend extends object = object,
> = FrameAccount<FrameAccountImplementation<chain, owner, extend>>

/** Create a frame account with overridable defaults for common account policies. */
export async function toFrameAccount<
  chain extends Chain | undefined,
  owner extends FrameAccountOwner,
  extend extends object = object,
>(
  parameters: ToFrameAccountParameters<chain, owner, extend>,
): Promise<ToFrameAccountReturnType<chain, owner, extend>> {
  const { client, owner } = parameters
  const getAddress =
    parameters.getAddress ?? (async () => parameters.address ?? owner.address)
  const signingOwner = ownerWithSigner(owner, parameters.sign)

  const getNonce =
    parameters.getNonce ??
    (async (nonceParameters: GetFrameNonceParameters = {}) =>
      getFrameNonceSeq(client, {
        address: await getAddress(),
        ...nonceParameters,
      }))

  const getValidationData =
    parameters.getValidationData ?? (async () => '0x' as const)

  const getSignatureEntries =
    parameters.getSignatureEntries ??
    (async () => {
      const sender = await getAddress()
      const useImplicitSigner =
        parameters.delegateAddress === undefined &&
        ownerSignatureScheme(owner) === 1 &&
        isAddressEqual(sender, owner.address)
      return [ownerSignatureEntry(owner, useImplicitSigner ? null : owner.address)]
    })

  const signFrameTransaction =
    parameters.signFrameTransaction ??
    (async (transaction: FrameTransaction) => {
      const sender = await getAddress()
      if (!isAddressEqual(transaction.sender, sender))
        throw new FrameEncodeError(
          `transaction sender ${transaction.sender} does not match frame account ${sender}`,
        )

      let prepared = transaction
      let signatureIndex = findOwnerSignatureIndex(prepared, owner, 'first')
      if (signatureIndex === -1) {
        const entries = await getSignatureEntries(transaction)
        prepared = {
          ...transaction,
          signatures: [...entries, ...transaction.signatures],
        }
        signatureIndex = findOwnerSignatureIndex(prepared, owner, 'first')
      }
      if (signatureIndex === -1)
        throw new FrameEncodeError(
          `frame account ${sender} has no signable entry for owner ${owner.address}`,
        )

      return signFrameSignature(prepared, signatureIndex, signingOwner)
    })

  const { extend, sign: _sign, address: _address, ...rest } = parameters
  const address = await getAddress()
  return {
    ...extend,
    ...rest,
    owner,
    execution: parameters.execution ?? { type: 'direct' },
    getAddress,
    getNonce,
    getValidationData,
    getSignatureEntries,
    signFrameTransaction,
    address,
    type: 'frame',
  } as ToFrameAccountReturnType<chain, owner, extend>
}
