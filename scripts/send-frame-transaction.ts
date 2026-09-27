/**
 * Send native ETH with the high-level `sendFrameTransaction` function.
 *
 * Required:
 *   PRIVATE_KEY=0x... RECIPIENT=0x... \
 *     bun run scripts/send-frame-transaction.ts
 *
 * Optional:
 *   AMOUNT_ETH=0.001
 *   RPC_URL=https://rpc1.privacy.ethrex.xyz
 *
 * This script broadcasts immediately. The sender pays both the transfer value
 * and gas because no separate payer is supplied.
 */
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  hegotaTestnet,
  sendFrameTransaction,
  toEoaFrameAccount,
  toEoaFramePayerAccount,
} from '../src/index.js'
import { frameActions } from '../src/viem.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function privateKeyFromEnv(name: string): Hex {
  const value = requiredEnv(name)
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${name} must be a 32-byte 0x-prefixed hex value`)
  return value as Hex
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? hegotaTestnet.rpcUrls.default.http[0]
  const owner = privateKeyToAccount(privateKeyFromEnv('PRIVATE_KEY'))
  const payer = privateKeyToAccount(privateKeyFromEnv('PAYMASTER_PRIVATE_KEY'))
  const recipient: Address = getAddress(requiredEnv('RECIPIENT'))
  const amount = parseEther(process.env.AMOUNT_ETH ?? '0.001')
  const client = createPublicClient({
    chain: hegotaTestnet,
    transport: http(rpcUrl),
  }).extend(frameActions)
  const account = await toEoaFrameAccount({ client, owner })

  console.log(`sender:    ${account.address}`)
  console.log(`recipient: ${recipient}`)
  console.log(`amount:    ${formatEther(amount)} ETH`)

  const hash = await sendFrameTransaction(
    account,
    [{ to: recipient, value: amount }],
    {
      limits: {
        validation: { execution: 30_000n, state: 0n },
        calls: [{ execution: 30_000n, state: 200_000n }],
      },
      paymaster: {
        account: await toEoaFramePayerAccount({ owner: payer }),
        limits: { execution: 30_000n, state: 200_000n },
      },
    },
  )

  console.log(`submitted: ${hash}`)
  const receipt = await client.waitForFrameTransactionReceipt({
    hash,
    timeout: 120_000,
  })
  console.log('payer:', receipt.payer)
  console.log('frames:', receipt.frameReceipts)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
