/**
 * Send native ETH from a code-less EOA while a second code-less EOA pays gas.
 *
 * Required:
 *   PRIVATE_KEY=0x... PAYMASTER_PRIVATE_KEY=0x... RECIPIENT=0x... \
 *     bun run scripts/send-eth-paymaster.ts
 *
 * Optional:
 *   AMOUNT_ETH=0.1
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
  isAddressEqual,
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
  toEoaFramePayerAccount,
  type FrameRpcClient,
  type RpcFrameReceiptJson,
} from '../src/index.js'

const RECEIPT_TIMEOUT_MS = 120_000

type BalanceSnapshot = {
  sender: bigint
  payer: bigint
  recipient: bigint
}

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

function formatSignedEther(value: bigint): string {
  const sign = value > 0n ? '+' : ''
  return `${sign}${formatEther(value)} ETH`
}

function printBalanceChanges(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
  amount: bigint,
): void {
  const senderDelta = after.sender - before.sender
  const payerDelta = after.payer - before.payer
  const recipientDelta = after.recipient - before.recipient

  console.log('\nbalance changes:')
  console.log(
    `  sender:    ${formatEther(before.sender)} -> ${formatEther(after.sender)} ETH (${formatSignedEther(senderDelta)})`,
  )
  console.log(
    `  recipient: ${formatEther(before.recipient)} -> ${formatEther(after.recipient)} ETH (${formatSignedEther(recipientDelta)})`,
  )
  console.log(
    `  payer:     ${formatEther(before.payer)} -> ${formatEther(after.payer)} ETH (${formatSignedEther(payerDelta)})`,
  )

  console.log('\ninterpretation:')
  console.log(`  requested transfer:       ${formatEther(amount)} ETH`)
  console.log(`  sender transfer variance: ${formatSignedEther(senderDelta + amount)}`)
  console.log(`  recipient variance:       ${formatSignedEther(recipientDelta - amount)}`)
  console.log(`  payer net gas cost:       ${formatEther(-payerDelta)} ETH`)
  console.log(
    `  tracked net change:       ${formatSignedEther(senderDelta + recipientDelta + payerDelta)}`,
  )
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
  const owner = privateKeyToAccount(privateKeyFromEnv('PRIVATE_KEY'))
  const payerOwner = privateKeyToAccount(
    privateKeyFromEnv('PAYMASTER_PRIVATE_KEY'),
  )
  const recipient: Address = getAddress(requiredEnv('RECIPIENT'))
  const amount = parseEther(process.env.AMOUNT_ETH ?? '0.1')
  const dryRun = process.env.DRY_RUN === '1'

  const client = createPublicClient({
    chain: hegotaTestnet,
    transport: http(rpcUrl),
  })
  const account = await toEoaFrameAccount({ client, owner })
  const payer = await toEoaFramePayerAccount({ owner: payerOwner })

  const unsigned = await prepareFrameTransaction(
    account,
    [{ to: recipient, value: amount, data: '0x' }],
    {
      validation: { execution: 30_000n, state: 0n },
      calls: [{ execution: 30_000n, state: 200_000n }],
    },
    {
      paymaster: {
        account: payer,
        limits: { execution: 30_000n, state: 200_000n },
      },
    },
  )

  const signed = await signFrameTransaction(account, unsigned, { payer })
  assertValidFrameTx(signed)

  const raw = encodeFrameTx(signed)
  const transactionHash = keccak256(raw)
  const gas = frameTxGas(signed)
  const maxGasCost = frameTxMaxCost(signed, 0n)

  console.log(`raw tx:       ${raw}`)
  console.log(`sender:       ${account.address}`)
  console.log(`payer:        ${payer.address}`)
  console.log(`recipient:    ${recipient}`)
  console.log(`amount:       ${formatEther(amount)} ETH`)
  console.log(`nonce keys:   [${signed.nonceKeys.join(', ')}] at seq ${signed.nonceSeq}`)
  console.log(`max gas:      ${gas.maxGas}`)
  console.log(`max gas cost: ${formatEther(maxGasCost)} ETH`)
  console.log(`local hash:   ${transactionHash}`)

  const simulation = await simulateFrameTransaction(client, raw)
  console.log(`simulated:    valid=${simulation.valid} prefix=${simulation.prefixShape}`)
  console.log(`  payer:      ${simulation.payer}`)
  console.log(`  gas used:   ${simulation.gasUsed}`)
  console.log(`  max cost:   ${simulation.maxCost} (local ${maxGasCost})`)
  if (!simulation.valid)
    throw new Error(
      `simulation rejected the transaction: ${simulation.violation}`,
    )

  const [senderBalanceBefore, payerBalanceBefore, recipientBalanceBefore] =
    await Promise.all([
      client.getBalance({ address: account.address }),
      client.getBalance({ address: payer.address }),
      client.getBalance({ address: recipient }),
    ])
  const balancesBefore: BalanceSnapshot = {
    sender: senderBalanceBefore,
    payer: payerBalanceBefore,
    recipient: recipientBalanceBefore,
  }

  if (dryRun) {
    console.log('DRY_RUN=1, so the valid transaction was not broadcast')
    console.log('\ncurrent balances:')
    console.log(`  sender:    ${formatEther(balancesBefore.sender)} ETH`)
    console.log(`  recipient: ${formatEther(balancesBefore.recipient)} ETH`)
    console.log(`  payer:     ${formatEther(balancesBefore.payer)} ETH`)
    console.log('\nprojected changes if broadcast:')
    console.log(`  sender:    -${formatEther(amount)} ETH`)
    console.log(`  recipient: +${formatEther(amount)} ETH`)
    console.log(`  payer:     gas used, capped at ${formatEther(maxGasCost)} ETH`)
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

  const [senderBalanceAfter, payerBalanceAfter, recipientBalanceAfter] =
    await Promise.all([
      client.getBalance({ address: account.address }),
      client.getBalance({ address: payer.address }),
      client.getBalance({ address: recipient }),
    ])

  const addressesAreDistinct =
    !isAddressEqual(account.address, payer.address) &&
    !isAddressEqual(account.address, recipient) &&
    !isAddressEqual(payer.address, recipient)
  if (!addressesAreDistinct)
    console.log(
      '\nnote: sender, recipient, and payer are not distinct; role deltas overlap.',
    )

  printBalanceChanges(
    balancesBefore,
    {
      sender: senderBalanceAfter,
      payer: payerBalanceAfter,
      recipient: recipientBalanceAfter,
    },
    amount,
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
