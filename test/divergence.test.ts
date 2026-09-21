import { describe, expect, test } from 'vitest'
import { compareRuleSets } from '../src/divergence.js'
import { frameTxGas } from '../src/gas.js'
import { GOLDEN_TX } from './fixtures/golden.js'

describe('compatibility rule-set aliases', () => {
  test('all rule-set names use the current accounting rules', () => {
    expect(compareRuleSets(GOLDEN_TX, 'chain', 'pins')).toEqual([])
    expect(compareRuleSets(GOLDEN_TX, 'pins', 'head')).toEqual([])
  })

  test('a targetless self-transfer has no value-transfer charge', () => {
    const tx = {
      ...GOLDEN_TX,
      frames: [
        {
          ...GOLDEN_TX.frames[1]!,
          target: null,
          value: 1n,
        },
      ],
    }
    expect(frameTxGas(tx).valueTransferCost).toBe(0n)
  })
})
