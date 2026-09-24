import {
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hash,
  type Hex,
  type JsonRpcAccount,
  type LocalAccount,
  type Transport,
  isAddressEqual,
} from 'viem'
import { signFrameTx } from '../signatures.js'
import { FrameEncodeError } from '../errors.js'
import { getFrameNonceSeq } from '../nonce.js'
import type { FrameTransaction } from '../types.js'
import { toFrameAccount } from './toFrameAccount.js'
import type { FrameAccount, FrameAccountImplementation } from './types.js'

export type EoaFrameOwner = Account & {
  address: Address
  sign: (parameters: { hash: Hash }) => Promise<Hex>
}

export type EoaFrameAccountImplementation<
  chain extends Chain | undefined = Chain | undefined,
  owner extends EoaFrameOwner = EoaFrameOwner,
  extend extends object = object,
> = FrameAccountImplementation<chain, owner, extend>

export type ToEoaFrameAccountParameters<
  chain extends Chain | undefined = Chain | undefined,
  owner extends EoaFrameOwner = EoaFrameOwner,
  extend extends object = object,
> = {
  client: Client<
    Transport,
    chain,
    JsonRpcAccount | LocalAccount | undefined
  >
  owner: owner
  extend?: extend | undefined
}

export type ToEoaFrameAccountReturnType<
  chain extends Chain | undefined = Chain | undefined,
  owner extends EoaFrameOwner = EoaFrameOwner,
  extend extends object = object,
> = FrameAccount<EoaFrameAccountImplementation<chain, owner, extend>>

/** Create a direct-execution frame account backed by an ordinary EOA. */
export async function toEoaFrameAccount<
  chain extends Chain | undefined,
  owner extends EoaFrameOwner,
  extend extends object = object,
>(
  parameters: ToEoaFrameAccountParameters<chain, owner, extend>,
): Promise<ToEoaFrameAccountReturnType<chain, owner, extend>> {
  const { client, owner } = parameters

  return toFrameAccount({
    client,
    owner,
    execution: { type: 'direct' },
    ...(parameters.extend === undefined ? {} : { extend: parameters.extend }),
    async getAddress() {
      return owner.address
    },
    async getNonce(nonceParameters = {}) {
      return getFrameNonceSeq(client, { address: owner.address, ...nonceParameters })
    },
    async getValidationData() {
      return '0x'
    },
    async signFrameTransaction(transaction: FrameTransaction) {
      if (!isAddressEqual(transaction.sender, owner.address))
        throw new FrameEncodeError(
          `transaction sender ${transaction.sender} does not match EOA ${owner.address}`,
        )

      return signFrameTx(
        {
          ...transaction,
          signatures: [
            {
              scheme: 1,
              signer: null,
              msg: '0x',
              signature: '0x',
            },
          ],
        },
        owner,
      )
    },
  })
}
