/**
 * Send native ETH from a code-less EOA using an EIP-8141 frame transaction.
 *
 * Required:
 *   PRIVATE_KEY=0x... RECIPIENT=0x... bun run scripts/send-eth-eoa.ts
 *
 * Optional:
 *   AMOUNT_ETH=0.001
 *   RPC_URL=https://rpc1.privacy.ethrex.xyz
 *   DRY_RUN=1   simulate only; do not broadcast
 *
 * The transaction is always simulated with `ethrex_simulateFrameTransaction`
 * first, and is not broadcast unless the node reports it valid.
 */
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  assertValidFrameTx,
  encodeFrameTx,
  frameTxGas,
  frameTxMaxCost,
  hegotaTestnet,
  parseRpcFrameReceipt,
  prepareFrameTransaction,
  simulateFrameTransaction,
  signFrameTransaction,
  toEoaFrameAccount,
  type FrameRpcClient,
  type RpcFrameReceiptJson,
} from '../src/index.js'

const RECEIPT_TIMEOUT_MS = 120_000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function privateKeyFromEnv(): Hex {
  const value = requiredEnv('PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('PRIVATE_KEY must be a 32-byte 0x-prefixed hex value')
  return value as Hex
}

async function waitForFrameReceipt(
  client: FrameRpcClient,
  hash: Hex,
): Promise<RpcFrameReceiptJson> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS

  while (Date.now() < deadline) {
    const receipt = (await client.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    })) as RpcFrameReceiptJson | null

    if (receipt !== null) return receipt
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(
    `transaction ${hash} was not mined within ${RECEIPT_TIMEOUT_MS / 1_000}s`,
  )
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? hegotaTestnet.rpcUrls.default.http[0]
  const owner = privateKeyToAccount(privateKeyFromEnv())
  const recipient: Address = getAddress(requiredEnv('RECIPIENT'))
  const amount = parseEther(process.env.AMOUNT_ETH ?? '0.001')
  const dryRun = process.env.DRY_RUN === '1'

  const client = createPublicClient({
    chain: hegotaTestnet,
    transport: http(rpcUrl),
  })
  const account = await toEoaFrameAccount({ client, owner })

  const unsigned = await prepareFrameTransaction(
    account,
    [{ to: recipient, value: amount, data: '0x' }],
    {
      validation: { execution: 80_000n, state: 0n },
      calls: [{ execution: 30_000n, state: 200_000n }],
    },
  )

  const signed = await signFrameTransaction(account, unsigned)
  assertValidFrameTx(signed)

  const raw = encodeFrameTx(signed)
  const transactionHash = keccak256(raw)
  const gas = frameTxGas(signed)
  const maxGasCost = frameTxMaxCost(signed, 0n)

  console.log(`raw tx:       ${raw}`)
  console.log(`sender:       ${account.address}`)
  console.log(`recipient:    ${recipient}`)
  console.log(`amount:       ${formatEther(amount)} ETH`)
  console.log(`nonce keys:   [${signed.nonceKeys.join(', ')}] at seq ${signed.nonceSeq}`)
  console.log(`max gas:      ${gas.maxGas}`)
  console.log(`max gas cost: ${formatEther(maxGasCost)} ETH`)
  console.log(`local hash:   ${transactionHash}`)

  const simulation = await simulateFrameTransaction(client, raw)
  console.log(`simulated:    valid=${simulation.valid} prefix=${simulation.prefixShape}`)
  console.log(`  gas used:   ${simulation.gasUsed}`)
  console.log(`  max cost:   ${simulation.maxCost} (local ${maxGasCost})`)
  if (!simulation.valid) throw new Error(`simulation rejected the transaction: ${simulation.violation}`)

  if (dryRun) {
    console.log('DRY_RUN=1, so the valid transaction was not broadcast')
    return
  }

  const submittedHash = (await client.request({
    method: 'eth_sendRawTransaction',
    params: [raw],
  })) as Hex

  if (submittedHash.toLowerCase() !== transactionHash.toLowerCase())
    throw new Error(
      `node returned hash ${submittedHash}, expected ${transactionHash}`,
    )

  console.log(`submitted:    ${submittedHash}`)
  const rpcReceipt = await waitForFrameReceipt(client, submittedHash)
  const receipt = parseRpcFrameReceipt(rpcReceipt)
  console.log('payer:', receipt.payer)
  console.log('frames:', receipt.frameReceipts)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
