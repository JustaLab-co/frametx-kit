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
import {
  type P256FrameSigner,
  signP256FrameSignature,
} from '../p256.js'
import type { FrameTransaction } from '../types.js'
import { toFrameAccount } from './toFrameAccount.js'
import type { FrameAccount, FrameAccountImplementation } from './types.js'

export type P256FrameAccountImplementation<
  chain extends Chain | undefined = Chain | undefined,
  extend extends object = object,
> = FrameAccountImplementation<chain, undefined, extend>

export type ToP256FrameAccountParameters<
  chain extends Chain | undefined = Chain | undefined,
  extend extends object = object,
> = {
  client: Client<Transport, chain, JsonRpcAccount | LocalAccount | undefined>
  /** EIP-7702 delegated EOA represented by this frame account. */
  address: Address
  signer: P256FrameSigner
  extend?: extend | undefined
}

export type ToP256FrameAccountReturnType<
  chain extends Chain | undefined = Chain | undefined,
  extend extends object = object,
> = FrameAccount<P256FrameAccountImplementation<chain, extend>>

/** Create a direct-execution frame account authorized by a P-256 signer. */
export async function toP256FrameAccount<
  chain extends Chain | undefined,
  extend extends object = object,
>(
  parameters: ToP256FrameAccountParameters<chain, extend>,
): Promise<ToP256FrameAccountReturnType<chain, extend>> {
  const { address, client, signer } = parameters

  return toFrameAccount({
    client,
    owner: undefined,
    execution: { type: 'direct' },
    ...(parameters.extend === undefined ? {} : { extend: parameters.extend }),
    async getAddress() {
      return address
    },
    async getNonce(nonceParameters = {}) {
      return getFrameNonceSeq(client, { address, ...nonceParameters })
    },
    async getValidationData() {
      return '0x'
    },
    async getSignatureEntries() {
      return [
        {
          scheme: 2,
          signer: signer.address,
          msg: '0x',
          signature: '0x',
        },
      ]
    },
    async signFrameTransaction(transaction: FrameTransaction) {
      if (!isAddressEqual(transaction.sender, address))
        throw new FrameEncodeError(
          `transaction sender ${transaction.sender} does not match P-256 frame account ${address}`,
        )

      const prepared =
        transaction.signatures.length === 0
          ? {
              ...transaction,
              signatures: [
                {
                  scheme: 2 as const,
                  signer: signer.address,
                  msg: '0x' as const,
                  signature: '0x' as const,
                },
              ],
            }
          : transaction

      return signP256FrameSignature(prepared, 0, signer)
    },
  })
}
