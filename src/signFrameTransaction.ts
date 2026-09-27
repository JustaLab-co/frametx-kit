import { isAddressEqual } from 'viem'
import type {
  FrameAccount,
  FrameAccountImplementation,
  FramePayerAccount,
  FramePayerAccountImplementation,
} from './accounts/types.js'
import { FrameEncodeError } from './errors.js'
import { assertValidFrameTx } from './signatures.js'
import type { FrameTransaction } from './types.js'

export type SignFrameTransactionOptions<
  payerImplementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = {
  payer?: FramePayerAccount<payerImplementation> | undefined
}

/** Sign a prepared transaction using its frame account's signing strategy. */
export async function signFrameTransaction<
  implementation extends FrameAccountImplementation,
  payerImplementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
>(
  account: FrameAccount<implementation>,
  transaction: FrameTransaction,
  options: SignFrameTransactionOptions<payerImplementation> = {},
): Promise<FrameTransaction> {
  if (!isAddressEqual(transaction.sender, account.address))
    throw new FrameEncodeError(
      `transaction sender ${transaction.sender} does not match frame account ${account.address}`,
    )

  const senderSigned = await account.signFrameTransaction(transaction)
  const signed =
    options.payer === undefined
      ? senderSigned
      : await options.payer.signFrameTransaction(senderSigned)
  assertValidFrameTx(signed)
  return signed
}
