import { defineChain } from 'viem'

/** The Ethrex hegota-testnet, the chain this library's envelope targets. */
export const hegotaTestnet = defineChain({
  id: 8141,
  name: 'Ethrex Hegota Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc1.privacy.ethrex.xyz'] } },
  blockExplorers: { default: { name: 'Dora', url: 'https://dora.privacy.ethrex.xyz' } },
  testnet: true,
})
