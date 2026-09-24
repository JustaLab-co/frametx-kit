import type { BlockTag, Chain, Hex } from 'viem'
import { MAX_FRAMES } from './envelope.js'
import { FrameEncodeError } from './errors.js'
import type { FrameAccount, FrameAccountImplementation, FrameCall } from './accounts/types.js'
import type { FrameLimits, FrameTransaction } from './types.js'

export type PrepareFrameLimits = {
  /** Limits for the leading VERIFY frame. */
  validation: FrameLimits
  /** One limit entry for each call, in the same order as `calls`. */
  calls: readonly FrameLimits[]
}

export type PrepareFrameTransactionOptions = {
  /** State used for nonce and fee reads. */
  blockTag?: BlockTag | undefined
  /**
   * EIP-8250 nonce keys to consume. Defaults to `[0n]`, the account nonce. With
   * several keys, every key must currently sit at the same sequence, because one
   * `nonceSeq` is matched against all of them.
   */
  nonceKeys?: readonly bigint[] | undefined
}

type RpcBlock = {
  baseFeePerGas?: Hex | null | undefined
}

function assertLimits(limits: FrameLimits, label: string): void {
  if (limits.execution < 0n)
    throw new FrameEncodeError(`${label}.execution must not be negative`)
  if (limits.state < 0n)
    throw new FrameEncodeError(`${label}.state must not be negative`)
}

async function getFees(
  account: FrameAccount,
  blockTag: BlockTag,
): Promise<{ maxPriorityFeePerGas: bigint; maxFeePerGas: bigint }> {
  const [priorityHex, block, gasPriceHex] = await Promise.all([
    account.client.request({ method: 'eth_maxPriorityFeePerGas' }),
    account.client.request({
      method: 'eth_getBlockByNumber',
      params: [blockTag, false],
    }) as Promise<RpcBlock | null>,
    account.client.request({ method: 'eth_gasPrice' }),
  ])

  const suggestedPriorityFee = BigInt(priorityHex)
  const gasPrice = BigInt(gasPriceHex)
  const baseFeePerGas = block?.baseFeePerGas

  if (baseFeePerGas === undefined || baseFeePerGas === null) {
    return {
      maxPriorityFeePerGas:
        suggestedPriorityFee < gasPrice ? suggestedPriorityFee : gasPrice,
      maxFeePerGas: gasPrice,
    }
  }

  return {
    maxPriorityFeePerGas: suggestedPriorityFee,
    maxFeePerGas: BigInt(baseFeePerGas) * 2n + suggestedPriorityFee,
  }
}

/**
 * Build an unsigned direct-execution frame transaction.
 *
 * The returned transaction contains one leading VERIFY frame followed by one
 * SENDER frame per call. Pass it to `account.signFrameTransaction` to produce
 * the transaction that can be validated and encoded.
 */
export async function prepareFrameTransaction<
  implementation extends FrameAccountImplementation<Chain>,
>(
  account: FrameAccount<implementation>,
  calls: readonly FrameCall[],
  frameLimits: PrepareFrameLimits,
  options: PrepareFrameTransactionOptions = {},
): Promise<FrameTransaction> {
  if (calls.length === 0)
    throw new FrameEncodeError('prepareFrameTransaction requires at least one call')
  if (calls.length + 1 > MAX_FRAMES)
    throw new FrameEncodeError(
      `prepareFrameTransaction supports at most ${MAX_FRAMES - 1} calls because the validation frame also counts toward the ${MAX_FRAMES}-frame limit`,
    )
  if (frameLimits.calls.length !== calls.length)
    throw new FrameEncodeError(
      `frameLimits.calls must contain one entry per call: expected ${calls.length}, got ${frameLimits.calls.length}`,
    )

  assertLimits(frameLimits.validation, 'frameLimits.validation')
  for (const [index, limits] of frameLimits.calls.entries())
    assertLimits(limits, `frameLimits.calls[${index}]`)

  const blockTag = options.blockTag ?? 'pending'
  const nonceKeys = [...(options.nonceKeys ?? [0n])]
  if (nonceKeys.length === 0)
    throw new FrameEncodeError('nonceKeys must hold at least one key')
  const [sequences, fees] = await Promise.all([
    Promise.all(nonceKeys.map((key) => account.getNonce({ key, blockTag }))),
    getFees(account, blockTag),
  ])
  const nonceSeq = sequences[0]!
  for (const [index, sequence] of sequences.entries())
    if (sequence !== nonceSeq)
      throw new FrameEncodeError(
        `nonce keys are at different sequences: key ${nonceKeys[0]} is at ${nonceSeq}, key ${nonceKeys[index]} is at ${sequence}; one nonceSeq cannot select both`,
      )
  const chainId = BigInt(account.client.chain.id)
  const validationData = await account.getValidationData({
    calls,
    chainId,
    nonceKeys,
    nonceSeq,
  })

  return {
    chainId,
    nonceKeys,
    nonceSeq,
    sender: account.address,
    frames: [
      {
        mode: 1,
        flags: 0x3,
        target: null,
        limits: frameLimits.validation,
        value: 0n,
        data: validationData,
      },
      ...calls.map((call, index) => ({
        mode: 2 as const,
        flags: 0,
        target: call.to,
        limits: frameLimits.calls[index]!,
        value: call.value,
        data: call.data,
      })),
    ],
    signatures: [],
    ...fees,
    maxFeePerBlobGas: 0n,
    blobVersionedHashes: [],
  }
}
