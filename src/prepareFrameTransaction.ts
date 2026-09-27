import type { BlockTag, Chain, Hex } from 'viem'
import { MAX_FRAMES, assertNonceKeys } from './envelope.js'
import { FrameEncodeError } from './errors.js'
import type {
  FrameAccount,
  FrameAccountImplementation,
  FrameCall,
  FramePaymasterParameters,
} from './accounts/types.js'
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
   * `nonceSeq` is matched against all of them. The list must also pass the
   * static EIP-8250 rules: at most `MAX_NONCE_KEYS`, strictly increasing, and
   * key `0` only on its own.
   */
  nonceKeys?: readonly bigint[] | undefined
  /** Optional payer represented by an EIP-8141 `pay` VERIFY frame. */
  paymaster?: FramePaymasterParameters | undefined
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
 * Without a paymaster, the returned transaction contains one `self_verify`
 * frame followed by one SENDER frame per call. With a paymaster, it contains
 * `only_verify`, `pay`, then the SENDER frames. Pass it to
 * `signFrameTransaction`, including the payer when present, to populate the
 * prepared signature entries.
 */
export async function prepareFrameTransaction<
  implementation extends FrameAccountImplementation<Chain>,
>(
  account: FrameAccount<implementation>,
  calls: readonly FrameCall[],
  frameLimits: PrepareFrameLimits,
  options: PrepareFrameTransactionOptions = {},
): Promise<FrameTransaction> {
  const { paymaster } = options
  const validationFrameCount = paymaster === undefined ? 1 : 2
  if (calls.length === 0)
    throw new FrameEncodeError('prepareFrameTransaction requires at least one call')
  if (calls.length + validationFrameCount > MAX_FRAMES)
    throw new FrameEncodeError(
      `prepareFrameTransaction supports at most ${MAX_FRAMES - validationFrameCount} calls with ${validationFrameCount} validation frame${validationFrameCount === 1 ? '' : 's'}`,
    )
  if (frameLimits.calls.length !== calls.length)
    throw new FrameEncodeError(
      `frameLimits.calls must contain one entry per call: expected ${calls.length}, got ${frameLimits.calls.length}`,
    )

  assertLimits(frameLimits.validation, 'frameLimits.validation')
  if (paymaster !== undefined) assertLimits(paymaster.limits, 'paymaster.limits')
  for (const [index, limits] of frameLimits.calls.entries())
    assertLimits(limits, `frameLimits.calls[${index}]`)

  const blockTag = options.blockTag ?? 'pending'
  const nonceKeys = [...(options.nonceKeys ?? [0n])]
  assertNonceKeys(nonceKeys)
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
    ...(paymaster === undefined ? {} : { paymaster }),
  })

  const transaction: FrameTransaction = {
    chainId,
    nonceKeys,
    nonceSeq,
    sender: account.address,
    frames: [
      {
        mode: 1,
        flags: paymaster === undefined ? 0x3 : 0x2,
        target: null,
        limits: frameLimits.validation,
        value: 0n,
        data: validationData,
      },
      ...(paymaster === undefined
        ? []
        : [
            {
              mode: 1 as const,
              flags: 0x1,
              target: paymaster.account.address,
              limits: paymaster.limits,
              value: 0n,
              data: '0x' as const,
            },
          ]),
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

  if (paymaster !== undefined) {
    const payFrame = transaction.frames[1]!
    transaction.frames[1] = {
      ...payFrame,
      data: await paymaster.account.getPayData(transaction),
    }
  }

  const senderEntries = await account.getSignatureEntries(transaction)
  transaction.signatures = [...senderEntries]
  if (paymaster !== undefined) {
    const payerEntries = await paymaster.account.getSignatureEntries(transaction)
    transaction.signatures.push(...payerEntries)
  }

  return transaction
}
