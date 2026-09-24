import { type Address, type Hex, concatHex, toRlp } from 'viem'
import { byteLength, rlpUint } from './rlp.js'
import type { FrameTransaction, RuleSet, SigScheme } from './types.js'

// EIP-8141 Constants table. Written as published figures, never derived: ethrex's
// own suite missed the intrinsic dropping from 15000 to 12000 across 1372 tests
// because it derived the expected value from the constant under test.
export const FRAME_TX_INTRINSIC_COST = 12_000n
export const FRAME_TX_PER_FRAME_COST = 475n
export const FRAME_TX_VALUE_COST = 6_000n
export const STANDARD_TOKEN_COST = 4n
export const TOTAL_COST_FLOOR_PER_TOKEN = 16n
export const GAS_PER_BLOB = 131_072n

// EIP-8037 state gas that EIP-8250 nonce consumption charges against the
// payment-approving frame's `limits.state`. These are execution-time charges, so
// they are budgeting figures for callers sizing `limits.state`, not terms of
// `frameTxGas`. Both are `state bytes * cost_per_state_byte`, with the cost
// pinned at 1530 on hegota-testnet (ethrex `bdfc5d8`, `gas_cost.rs:194`).
/** A non-zero nonce key whose `NONCE_MANAGER` slot is still zero: 64 * 1530. */
export const KEYED_NONCE_FIRST_USE_STATE_GAS = 97_920n
/** Key `[0]` from a sender that does not exist yet: 120 * 1530. */
export const NEW_ACCOUNT_STATE_GAS = 183_600n

export const SIG_VERIFY_COST: Record<SigScheme, bigint> = {
  0: 100n,
  1: 2_800n,
  2: 6_700n,
}

export type FrameGas = {
  valueTransferCost: bigint
  signatureVerificationCost: bigint
  mandatoryGas: bigint
  /** Total length in bytes of every billed field. */
  billedBytes: bigint
  dataCost: bigint
  intrinsicGas: bigint
  stateGasLimit: bigint
  standardGasLimit: bigint
  calldataTokens: bigint
  calldataFloorGas: bigint
  calldataFloorTotal: bigint
  /** `max_gas`: the gas reserved from the block pool. */
  maxGas: bigint
}

/**
 * EIP-8250 `nonce_calldata`: `rlp(nonce_keys) || rlp(nonce_seq)`. The bytes the
 * keyed nonce adds to the payload, priced like frame and signature data.
 */
export function nonceCalldata(tx: FrameTransaction): Hex {
  return concatHex([
    toRlp(tx.nonceKeys.map(rlpUint), 'hex'),
    toRlp(rlpUint(tx.nonceSeq), 'hex'),
  ])
}

/**
 * The fields the calldata cost is charged over: each frame's `data`, each
 * signature's `signer`, `msg` and `signature`, and the nonce calldata. The
 * envelope's RLP framing and its other scalar fields are not billed.
 */
function billedFields(tx: FrameTransaction): Hex[] {
  return [
    ...tx.frames.map((f) => f.data),
    ...tx.signatures.flatMap((s) => [s.signer ?? '0x', s.msg, s.signature] as Hex[]),
    nonceCalldata(tx),
  ]
}

/** EIP-7623 calldata cost: 4 gas per zero byte, 16 per non-zero byte. */
function calldataCost(fields: Hex[]): bigint {
  let total = 0n
  for (const field of fields) {
    const body = field.slice(2)
    for (let i = 0; i < body.length; i += 2)
      total += body.slice(i, i + 2) === '00' ? 4n : 16n
  }
  return total
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * EIP-8141 `value_transfer_cost`.
 *
 * Charged only when a frame moves value to an explicit target other than the
 * transaction sender.
 */
function valueTransferCost(tx: FrameTransaction): bigint {
  let total = 0n
  for (const frame of tx.frames) {
    if (frame.value === 0n) continue
    if (frame.target !== null && !sameAddress(frame.target, tx.sender))
      total += FRAME_TX_VALUE_COST
  }
  return total
}

/**
 * Price a frame transaction. The rule-set argument remains as a compatibility
 * alias; all names use the current EIP-8141 accounting rules.
 */
export function frameTxGas(tx: FrameTransaction, _rules: RuleSet = 'chain'): FrameGas {
  const valueCost = valueTransferCost(tx)
  const sigCost = tx.signatures.reduce(
    (acc, s) => acc + SIG_VERIFY_COST[s.scheme],
    0n,
  )
  const mandatoryGas =
    FRAME_TX_INTRINSIC_COST +
    BigInt(tx.frames.length) * FRAME_TX_PER_FRAME_COST +
    sigCost +
    valueCost

  const fields = billedFields(tx)
  const billedBytes = fields.reduce((acc, f) => acc + BigInt(byteLength(f)), 0n)
  const dataCost = calldataCost(fields)

  const intrinsicGas = mandatoryGas + dataCost

  const stateGasLimit = tx.frames.reduce((acc, f) => acc + f.limits.state, 0n)
  const executionGasLimit = tx.frames.reduce((acc, f) => acc + f.limits.execution, 0n)
  const standardGasLimit = intrinsicGas + executionGasLimit + stateGasLimit

  const calldataTokens = billedBytes * STANDARD_TOKEN_COST
  const calldataFloorGas = calldataTokens * TOTAL_COST_FLOOR_PER_TOKEN
  const calldataFloorTotal = mandatoryGas + calldataFloorGas

  // State gas is added ON TOP of the floor: both bound an execution-dimension
  // resource, so the floor branch cannot absorb the state sum.
  const maxGas =
    standardGasLimit > calldataFloorTotal + stateGasLimit
      ? standardGasLimit
      : calldataFloorTotal + stateGasLimit

  return {
    valueTransferCost: valueCost,
    signatureVerificationCost: sigCost,
    mandatoryGas,
    billedBytes,
    dataCost,
    intrinsicGas,
    stateGasLimit,
    standardGasLimit,
    calldataTokens,
    calldataFloorGas,
    calldataFloorTotal,
    maxGas,
  }
}

/** TXPARAM 0x06: max_gas * max_fee_per_gas + len(blobs) * GAS_PER_BLOB * blob_base_fee. */
export function frameTxMaxCost(
  tx: FrameTransaction,
  blobBaseFee: bigint,
  rules: RuleSet = 'chain',
): bigint {
  const { maxGas } = frameTxGas(tx, rules)
  return (
    maxGas * tx.maxFeePerGas +
    BigInt(tx.blobVersionedHashes.length) * GAS_PER_BLOB * blobBaseFee
  )
}
