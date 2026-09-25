import { describe, expect, test } from 'vitest'
import { hegotaTestnet } from '../src/chain.js'

describe('hegotaTestnet', () => {
  test('is chain 8141 at the public endpoint', () => {
    expect(hegotaTestnet.id).toBe(8141)
    expect(hegotaTestnet.rpcUrls.default.http).toEqual(['https://rpc1.privacy.ethrex.xyz'])
    expect(hegotaTestnet.testnet).toBe(true)
  })
})
