import { createPublicClient, http } from 'viem'
import { describe, expect, test } from 'vitest'
import { hegotaTestnet } from '../../src/chain.js'

const live = process.env.FRAMES_LIVE === '1'

describe.skipIf(!live)('Ethrex hegota-testnet', () => {
  const client = createPublicClient({ chain: hegotaTestnet, transport: http() })

  test('reports the expected chain and an Ethrex client', async () => {
    expect(await client.getChainId()).toBe(hegotaTestnet.id)
    const version = await client.request({ method: 'web3_clientVersion' })
    expect(version).toMatch(/^ethrex\//)
  })
})
