/**
 * Send native ETH from an EIP-7702 delegated EOA using a P-256-authorized
 * EIP-8141 frame transaction.
 *
 * Required:
 *   SENDER=0x...
 *   RECIPIENT=0x...
 *   P256_PRIVATE_KEY_PATH=/absolute/path/to/p256-private.pem
 *
 * Optional:
 *   RPC_URL=https://rpc1.privacy.ethrex.xyz
 *   AMOUNT_ETH=0.000001
 *   P256_PRIVATE_KEY_PASSPHRASE=...
 *   P256_SIGNER_IDENTITY=0x...   independently assert the expected identity
 */
import { createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type Hex,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  parseEther,
} from 'viem'
import {
  hegotaTestnet,
  parseRpcFrameReceipt,
  privateKeyToP256FrameSigner,
  sendFrameTransaction,
  toP256FrameAccount,
  type FrameRpcClient,
  type RpcFrameReceiptJson,
} from '../src/index.js'

const RECEIPT_TIMEOUT_MS = 120_000
const P256_ACCOUNT_ABI = [
  {
    type: 'function',
    name: 'p256Signer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function loadP256PrivateKey(path: string): Hex {
  const pem = readFileSync(path)
  const passphrase = process.env.P256_PRIVATE_KEY_PASSPHRASE
  const key = createPrivateKey(
    passphrase === undefined ? pem : { key: pem, passphrase },
  )
  const jwk = key.export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d === undefined)
    throw new Error('P256_PRIVATE_KEY_PATH must contain a P-256 private PEM key')

  const privateKey = `0x${Buffer.from(jwk.d, 'base64url').toString('hex')}` as Hex
  if (!/^0x[0-9a-f]{64}$/.test(privateKey))
    throw new Error('P-256 private scalar must be exactly 32 bytes')
  return privateKey
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
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc1.privacy.ethrex.xyz'
  const sender = getAddress(requiredEnv('SENDER'))
  const recipient = getAddress(requiredEnv('RECIPIENT'))
  const amount = parseEther(process.env.AMOUNT_ETH ?? '0.000001')
  const signer = privateKeyToP256FrameSigner(
    loadP256PrivateKey(requiredEnv('P256_PRIVATE_KEY_PATH')),
  )

  const expectedIdentity = process.env.P256_SIGNER_IDENTITY
  if (
    expectedIdentity !== undefined &&
    !isAddressEqual(signer.address, getAddress(expectedIdentity))
  )
    throw new Error(
      `PEM signer identity ${signer.address} does not match P256_SIGNER_IDENTITY ${expectedIdentity}`,
    )

  const client = createPublicClient({
    chain: hegotaTestnet,
    transport: http(rpcUrl),
  })
  const code = await client.getCode({ address: sender })
  if (code === undefined || !code.toLowerCase().startsWith('0xef0100'))
    throw new Error(`sender ${sender} does not have an EIP-7702 delegation`)

  const signerCall = await client.call({
    to: sender,
    data: encodeFunctionData({ abi: P256_ACCOUNT_ABI, functionName: 'p256Signer' }),
  })
  if (signerCall.data === undefined)
    throw new Error(`p256Signer() returned no data for ${sender}`)
  const configuredSigner = decodeFunctionResult({
    abi: P256_ACCOUNT_ABI,
    functionName: 'p256Signer',
    data: signerCall.data,
  })
  if (!isAddressEqual(configuredSigner, signer.address))
    throw new Error(
      `delegated account authorizes ${configuredSigner}, but the PEM identity is ${signer.address}`,
    )

  const account = await toP256FrameAccount({ client, address: sender, signer })
  const [senderBalanceBefore, recipientBalanceBefore] = await Promise.all([
    client.getBalance({ address: sender }),
    client.getBalance({ address: recipient }),
  ])

  console.log(`sender:       ${sender}`)
  console.log(`recipient:    ${recipient}`)
  console.log(`amount:       ${formatEther(amount)} ETH`)
  console.log(`P-256 signer: ${signer.address}`)

  const submittedHash = await sendFrameTransaction(
    account,
    [{ to: recipient, value: amount }],
    {
      limits: {
        validation: { execution: 100_000n, state: 0n },
        calls: [{ execution: 30_000n, state: 200_000n }],
      },
    },
  )

  console.log(`submitted:    ${submittedHash}`)
  const rpcReceipt = await waitForFrameReceipt(client, submittedHash)
  const receipt = parseRpcFrameReceipt(rpcReceipt)
  const [senderBalanceAfter, recipientBalanceAfter] = await Promise.all([
    client.getBalance({ address: sender }),
    client.getBalance({ address: recipient }),
  ])

  console.log('payer:', receipt.payer)
  console.log('frames:', receipt.frameReceipts)
  console.log(`sender delta:    ${formatEther(senderBalanceAfter - senderBalanceBefore)} ETH`)
  console.log(
    `recipient delta: ${formatEther(recipientBalanceAfter - recipientBalanceBefore)} ETH`,
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
