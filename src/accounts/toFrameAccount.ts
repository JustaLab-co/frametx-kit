import {
  type Address,
  type Chain,
  type Client,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
  type Hex,
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

type FrameAccountBaseParameters<
  chain extends Chain | undefined = Chain | undefined,
  owner extends FrameAccountOwner | undefined = FrameAccountOwner | undefined,
  extend extends object = object,
> = {
  client: Client<Transport, chain, JsonRpcAccount | LocalAccount | undefined>
  owner?: owner | undefined
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

type DefaultFrameAccountParameters<
  chain extends Chain | undefined,
  owner extends FrameAccountOwner,
  extend extends object,
> = FrameAccountBaseParameters<chain, owner, extend> & { owner: owner }

type CustomFrameAccountParameters<
  chain extends Chain | undefined,
  extend extends object,
> = FrameAccountBaseParameters<chain, undefined, extend> & {
  owner?: undefined
  sign?: never
  getNonce: NonNullable<
    FrameAccountImplementation<chain, undefined, extend>['getNonce']
  >
  getValidationData: NonNullable<
    FrameAccountImplementation<chain, undefined, extend>['getValidationData']
  >
  getSignatureEntries: NonNullable<
    FrameAccountImplementation<chain, undefined, extend>['getSignatureEntries']
  >
  signFrameTransaction: NonNullable<
    FrameAccountImplementation<chain, undefined, extend>['signFrameTransaction']
  >
} & (
    | { address: Address; getAddress?: undefined }
    | { address?: Address | undefined; getAddress: () => Promise<Address> }
  )

export type ToFrameAccountParameters<
  chain extends Chain | undefined = Chain | undefined,
  owner extends FrameAccountOwner | undefined = FrameAccountOwner,
  extend extends object = object,
> = owner extends FrameAccountOwner
  ? DefaultFrameAccountParameters<chain, owner, extend>
  : CustomFrameAccountParameters<chain, extend>

export type ToFrameAccountReturnType<
  chain extends Chain | undefined = Chain | undefined,
  owner extends FrameAccountOwner | undefined = FrameAccountOwner,
  extend extends object = object,
> = FrameAccount<FrameAccountImplementation<chain, owner, extend>>

/** Create a frame account with overridable defaults for common account policies. */
export async function toFrameAccount<
  chain extends Chain | undefined,
  owner extends FrameAccountOwner | undefined,
  extend extends object = object,
>(
  parameters: ToFrameAccountParameters<chain, owner, extend>,
): Promise<ToFrameAccountReturnType<chain, owner, extend>> {
  const { client, owner } = parameters
  if (parameters.address !== undefined && parameters.getAddress !== undefined)
    throw new FrameEncodeError(
      'frame account parameters cannot include both address and getAddress',
    )
  const unresolvedAddress = parameters.address ?? owner?.address
  if (parameters.getAddress === undefined && unresolvedAddress === undefined)
    throw new FrameEncodeError(
      'ownerless frame account requires address or getAddress',
    )
  const address = await (parameters.getAddress?.() ??
    Promise.resolve(unresolvedAddress!))
  const getAddress = async () => address

  if (parameters.delegateAddress !== undefined) {
    const code = (await client.request({
      method: 'eth_getCode',
      params: [address, 'latest'],
    })) as Hex
    const expected = `0xef0100${parameters.delegateAddress.slice(2)}`.toLowerCase()
    if (code.toLowerCase() !== expected)
      throw new FrameEncodeError(
        `frame account ${address} delegates with ${code.length > 48 ? `${code.slice(0, 48)}...` : code}, expected ${expected}`,
      )
  }

  if (owner === undefined) {
    if (
      parameters.getNonce === undefined ||
      parameters.getValidationData === undefined ||
      parameters.getSignatureEntries === undefined ||
      parameters.signFrameTransaction === undefined
    )
      throw new FrameEncodeError(
        'ownerless frame account requires getNonce, getValidationData, getSignatureEntries, and signFrameTransaction',
      )

    const { extend, address: _address, ...rest } = parameters
    return {
      ...extend,
      ...rest,
      owner,
      execution: parameters.execution ?? { type: 'direct' },
      getAddress,
      getNonce: parameters.getNonce,
      getValidationData: parameters.getValidationData,
      getSignatureEntries: parameters.getSignatureEntries,
      signFrameTransaction: parameters.signFrameTransaction,
      address,
      type: 'frame',
    } as unknown as ToFrameAccountReturnType<chain, owner, extend>
  }
  const signingOwner = ownerWithSigner(owner, parameters.sign)

  const getNonce =
    parameters.getNonce ??
    (async (nonceParameters: GetFrameNonceParameters = {}) =>
      getFrameNonceSeq(client, {
        address,
        ...nonceParameters,
      }))

  const getValidationData =
    parameters.getValidationData ?? (async () => '0x' as const)

  const getSignatureEntries =
    parameters.getSignatureEntries ??
    (async () => {
      const useImplicitSigner =
        parameters.delegateAddress === undefined &&
        ownerSignatureScheme(owner) === 1 &&
        isAddressEqual(address, owner.address)
      return [ownerSignatureEntry(owner, useImplicitSigner ? null : owner.address)]
    })

  const signFrameTransaction =
    parameters.signFrameTransaction ??
    (async (transaction: FrameTransaction) => {
      if (!isAddressEqual(transaction.sender, address))
        throw new FrameEncodeError(
          `transaction sender ${transaction.sender} does not match frame account ${address}`,
        )

      let prepared = transaction
      let signatureIndex = findOwnerSignatureIndex(prepared, owner, 'first')
      if (signatureIndex === -1) {
        if (transaction.signatures.some((entry) => entry.signature !== '0x'))
          throw new FrameEncodeError(
            `frame account ${address} has no entry and other entries are already signed; install sender entries during preparation`,
          )
        const entries = await getSignatureEntries(transaction)
        prepared = {
          ...transaction,
          signatures: [...entries, ...transaction.signatures],
        }
        signatureIndex = findOwnerSignatureIndex(prepared, owner, 'first')
      }
      if (signatureIndex === -1)
        throw new FrameEncodeError(
          `frame account ${address} has no signable entry for owner ${owner.address}`,
        )

      return signFrameSignature(prepared, signatureIndex, signingOwner)
    })

  const { extend, sign: _sign, address: _address, ...rest } = parameters
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
  } as unknown as ToFrameAccountReturnType<chain, owner, extend>
}
