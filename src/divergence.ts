import { type FrameGas, frameTxGas } from './gas.js'
import type { FrameTransaction, RuleSet } from './types.js'

export type GasDivergence = {
  term: keyof FrameGas
  a: bigint
  b: bigint
  /** Always non-negative: the absolute difference between the two rule sets. */
  delta: bigint
}

/**
 * Every gas term on which two rule sets disagree for this transaction.
 *
 * An empty result means the transaction is priced identically under both — which
 * is the common case, because the live divergences are narrow. A non-empty result
 * on live chain data that the divergence ledger does not already explain is a
 * finding worth reporting.
 *
 * The rule-set names are compatibility aliases now that the current envelope
 * has removed the keyed-nonce and recent-root extensions.
 */
export function compareRuleSets(
  tx: FrameTransaction,
  a: RuleSet,
  b: RuleSet,
): GasDivergence[] {
  const gasA = frameTxGas(tx, a)
  const gasB = frameTxGas(tx, b)

  const divergences: GasDivergence[] = []
  for (const term of Object.keys(gasA) as (keyof FrameGas)[]) {
    const left = gasA[term]
    const right = gasB[term]
    if (left === right) continue
    divergences.push({
      term,
      a: left,
      b: right,
      delta: left > right ? left - right : right - left,
    })
  }
  return divergences
}
