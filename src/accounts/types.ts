import type {
  Account,
  Address,
  BlockTag,
  Chain,
  Client,
  Hex,
  JsonRpcAccount,
  LocalAccount,
  Transport,
} from 'viem'
import type {
  FrameLimits,
  FrameSignature,
  FrameTransaction,
} from '../types.js'

export type FrameCall = {
  to: Address
  value: bigint
  data: Hex
}

export type GetFrameNonceParameters = {
  /** EIP-8250 nonce key. Defaults to `0n`, the account nonce. */
  key?: bigint | undefined
  blockTag?: BlockTag | undefined
}

export type GetValidationDataParameters = {
  calls: readonly FrameCall[]
  chainId: bigint
  nonceKeys: readonly bigint[]
  nonceSeq: bigint
  paymaster?: FramePaymasterParameters | undefined
}

export type DirectFrameExecution = {
  type: 'direct'
}

export type FramePayerAccountImplementation<
  owner extends Account | undefined = Account | undefined,
  extend extends object = object,
> = {
  /** Account or signer that controls the payer. */
  owner: owner
  /** Add implementation-specific properties to the resolved payer account. */
  extend?: extend | undefined
  /** Resolve the address that calls `APPROVE(0x1)` and pays for the transaction. */
  getAddress: () => Promise<Address>
  /** Produce calldata for the payer's EIP-8141 `pay` VERIFY frame. */
  getPayData: (transaction: FrameTransaction) => Promise<Hex>
  /** Describe the payer-owned outer signature entries before anything signs. */
  getSignatureEntries: (
    transaction: FrameTransaction,
  ) => Promise<readonly FrameSignature[]>
  /** Populate the payer-owned signature entries in a prepared transaction. */
  signFrameTransaction: (
    transaction: FrameTransaction,
  ) => Promise<FrameTransaction>
}

/** Parameters used to construct an EIP-8141 `pay` validation frame. */
export type FramePaymasterParameters<
  implementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = {
  account: FramePayerAccount<implementation>
  limits: FrameLimits
}

/** Account-specific behavior required to construct and sign frame transactions. */
export type FrameAccountImplementation<
  chain extends Chain | undefined = Chain | undefined,
  owner extends Account | undefined = Account | undefined,
  extend extends object = object,
> = {
  /** Client used to read account and nonce state. */
  client: Client<
    Transport,
    chain,
    JsonRpcAccount | LocalAccount | undefined
  >
  /** Account or signer that controls the frame account. */
  owner: owner
  /** How calls are represented by execution frames. */
  execution: DirectFrameExecution
  /** Add implementation-specific properties to the resolved account. */
  extend?: extend | undefined
  /** Resolve the sender address represented by this account. */
  getAddress: () => Promise<Address>
  /** Resolve the current EIP-8250 sequence of one of the sender's nonce keys. */
  getNonce: (parameters?: GetFrameNonceParameters) => Promise<bigint>
  /** Produce calldata for the account's EIP-8141 validation frame. */
  getValidationData: (parameters: GetValidationDataParameters) => Promise<Hex>
  /** Describe the sender-owned outer signature entries before anything signs. */
  getSignatureEntries: (
    transaction: FrameTransaction,
  ) => Promise<readonly FrameSignature[]>
  /** Apply the account's signature scheme and ordering to a frame transaction. */
  signFrameTransaction: (
    transaction: FrameTransaction,
  ) => Promise<FrameTransaction>
}

type Assign<base extends object, overrides extends object> = Omit<
  base,
  keyof overrides
> &
  overrides

type Simplify<type> = { [key in keyof type]: type[key] } & {}

type AccountExtension<implementation extends FrameAccountImplementation> =
  NonNullable<implementation['extend']>

/** A resolved frame account, analogous to viem's resolved SmartAccount type. */
export type FrameAccount<
  implementation extends
    FrameAccountImplementation = FrameAccountImplementation,
> = Simplify<
  Assign<
    AccountExtension<implementation>,
    Assign<
      Omit<implementation, 'extend'>,
      {
        /** Resolved sender address. */
        address: Address
        /** Discriminator for frame-account-aware APIs. */
        type: 'frame'
      }
    >
  >
>

type PayerAccountExtension<
  implementation extends FramePayerAccountImplementation,
> = NonNullable<implementation['extend']>

/** A resolved account that authorizes and funds an EIP-8141 `pay` frame. */
export type FramePayerAccount<
  implementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = Simplify<
  Assign<
    PayerAccountExtension<implementation>,
    Assign<
      Omit<implementation, 'extend'>,
      {
        /** Resolved payer address. */
        address: Address
        /** Discriminator for frame-payer-aware APIs. */
        type: 'framePayer'
      }
    >
  >
>
