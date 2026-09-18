import { isAddressEqual } from 'viem'
import type { FrameAccount, FrameAccountImplementation } from './accounts/types.js'
import { FrameEncodeError } from './errors.js'
import type { FrameTransaction } from './types.js'

/** Sign a prepared transaction using its frame account's signing strategy. */
export async function signFrameTransaction<
  implementation extends FrameAccountImplementation,
>(
  account: FrameAccount<implementation>,
  transaction: FrameTransaction,
): Promise<FrameTransaction> {
  if (!isAddressEqual(transaction.sender, account.address))
    throw new FrameEncodeError(
      `transaction sender ${transaction.sender} does not match frame account ${account.address}`,
    )

  return account.signFrameTransaction(transaction)
}
