import { createPublicClient, http } from 'viem'
import { describe, expect, test } from 'vitest'

const RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
const CHAIN_ID = 8141
const live = process.env.FRAMES_LIVE === '1'

describe.skipIf(!live)('Ethrex hegota-testnet', () => {
  const client = createPublicClient({ transport: http(RPC_URL) })

  test('reports the expected chain and an Ethrex client', async () => {
    expect(await client.getChainId()).toBe(CHAIN_ID)
    const version = await client.request({ method: 'web3_clientVersion' })
    expect(version).toMatch(/^ethrex\//)
  })
})
