import type { Address, Chain, Hex } from 'viem'
import type {
  FrameAccount,
  FrameAccountImplementation,
  FramePayerAccount,
  FramePayerAccountImplementation,
} from './accounts/types.js'
import { encodeFrameTx } from './envelope.js'
import {
  prepareFrameTransaction,
  type PrepareFrameTransactionOptions,
} from './prepareFrameTransaction.js'
import { sendRawFrameTransaction } from './rpc.js'
import { signFrameTransaction } from './signFrameTransaction.js'
import type { FrameLimits } from './types.js'

export type SendFrameCall = {
  to: Address
  value?: bigint | undefined
  data?: Hex | undefined
}

export type SendFrameTransactionLimits = {
  /** Limits for the sender's leading VERIFY frame. */
  validation: FrameLimits
  /** One mandatory limit entry for each call, in the same order as `calls`. */
  calls: readonly FrameLimits[]
}

export type SendFrameTransactionOptions<
  payerImplementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = Omit<PrepareFrameTransactionOptions, 'paymaster'> & {
  limits: SendFrameTransactionLimits
  paymaster?:
    | {
        account: FramePayerAccount<payerImplementation>
        limits: FrameLimits
      }
    | undefined
}

/** Prepare, sign, encode, and broadcast a frame transaction. */
export async function sendFrameTransaction<
  implementation extends FrameAccountImplementation<Chain>,
  payerImplementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
>(
  account: FrameAccount<implementation>,
  calls: readonly SendFrameCall[],
  options: SendFrameTransactionOptions<payerImplementation>,
): Promise<Hex> {
  const normalizedCalls = calls.map((call) => ({
    to: call.to,
    value: call.value ?? 0n,
    data: call.data ?? ('0x' as const),
  }))
  const paymaster = options.paymaster
  const transaction = await prepareFrameTransaction(
    account,
    normalizedCalls,
    options.limits,
    {
      ...(options.blockTag === undefined ? {} : { blockTag: options.blockTag }),
      ...(options.nonceKeys === undefined ? {} : { nonceKeys: options.nonceKeys }),
      ...(paymaster === undefined
        ? {}
        : {
            paymaster: {
              account: paymaster.account,
              limits: paymaster.limits,
            },
          }),
    },
  )
  const signed = await signFrameTransaction(account, transaction, {
    ...(paymaster === undefined ? {} : { payer: paymaster.account }),
  })

  return sendRawFrameTransaction(account.client, encodeFrameTx(signed))
}
