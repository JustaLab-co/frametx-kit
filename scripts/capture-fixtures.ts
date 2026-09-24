/**
 * Capture live hegota-testnet frame transactions as test fixtures.
 *
 * The public endpoint serves no raw transaction bytes — ethrex has no
 * `eth_getRawTransactionByHash`, and `debug_getRawTransaction` is refused by
 * rpc1.privacy.ethrex.xyz — so a fixture holds what the node DOES serve: the
 * decoded transaction JSON (with its hash), the receipt, and the node's answer
 * to `ethrex_simulateFrameTransaction` over OUR re-encoding of that JSON. The
 * raw bytes are re-derived by the tests and pinned by the transaction hash,
 * which is keccak256 of exactly those bytes.
 *
 * Each capture also records the client version and genesis hash it was taken
 * against, as provenance.
 *
 * Usage:
 *   bunx tsx scripts/capture-fixtures.ts [from-block] [to-block]
 *     Defaults to the last 500 blocks. Frame transactions are sparse.
 *   bunx tsx scripts/capture-fixtures.ts 0x<hash> [0x<hash> ...]
 *     Capture the named transactions.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { type Hex, keccak256 } from 'viem'
import { encodeFrameTx } from '../src/envelope.js'
import { type RpcFrameTransaction, parseRpcFrameTransaction } from '../src/rpc.js'

const RPC_URL = 'https://rpc1.privacy.ethrex.xyz'
const EXPECTED_CHAIN_ID = 8141n
const OUT_DIR = new URL('../test/fixtures/chain/', import.meta.url)

let nextId = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  })
  const body = (await response.json()) as {
    result?: T
    error?: { code: number; message: string }
  }
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`)
  return body.result as T
}

type HydratedTx = RpcFrameTransaction & { hash: Hex; type: string }

async function main() {
  const chainId = BigInt(await rpc<Hex>('eth_chainId', []))
  if (chainId !== EXPECTED_CHAIN_ID)
    throw new Error(`expected chain ${EXPECTED_CHAIN_ID}, got ${chainId}`)

  const clientVersion = await rpc<string>('web3_clientVersion', [])
  const genesis = await rpc<{ hash: Hex }>('eth_getBlockByNumber', ['0x0', false])
  const head = BigInt(await rpc<Hex>('eth_blockNumber', []))

  mkdirSync(OUT_DIR, { recursive: true })
  const captured: string[] = []

  const args = process.argv.slice(2)
  const byHash = args.length > 0 && args.every((a) => /^0x[0-9a-fA-F]{64}$/.test(a))
  const to = !byHash && args[1] ? BigInt(args[1]) : head
  const from = !byHash && args[0] ? BigInt(args[0]) : to > 500n ? to - 500n : 0n

  async function* frameTransactions(): AsyncGenerator<{ n: bigint; tx: HydratedTx }> {
    if (byHash) {
      for (const hash of args) {
        const tx = await rpc<(HydratedTx & { blockNumber: Hex }) | null>(
          'eth_getTransactionByHash',
          [hash],
        )
        if (tx === null) throw new Error(`${hash}: not found`)
        yield { n: BigInt(tx.blockNumber), tx }
      }
      return
    }
    for (let n = from; n <= to; n++) {
      const block = await rpc<{ transactions: HydratedTx[] }>('eth_getBlockByNumber', [
        `0x${n.toString(16)}`,
        true,
      ])
      for (const tx of block.transactions) yield { n, tx }
    }
  }

  for await (const { n, tx } of frameTransactions()) {
    if (tx.type !== '0x6') continue // `{:#x}` of 6 is one hex digit, not two

    const receipt = await rpc<unknown>('eth_getTransactionReceipt', [tx.hash])

    // Our re-encoding. Checked against the hash here only to WARN: a mismatch is
    // a finding for Oracle 2 in test/oracles.test.ts, which fails loudly, so
    // the fixture is still written. `simulate` over wrong bytes is then noise.
    const raw = encodeFrameTx(parseRpcFrameTransaction(tx))
    if (keccak256(raw) !== tx.hash)
      console.warn(`block ${n} ${tx.hash}: re-encoding does not reproduce the hash`)

    // The node's verdict on our bytes. `maxCost` is a pure function of the
    // fields (hermetic oracle); `violation` records how far the node got —
    // anything past "does not authenticate the sender" means our sig_hash
    // over a real signature matched. Only `latest` is available: state is pruned.
    const simulate = await rpc<unknown>('ethrex_simulateFrameTransaction', [raw, 'latest'])

    writeFileSync(
      new URL(`${tx.hash}.json`, OUT_DIR),
      `${JSON.stringify(
        {
          meta: {
            clientVersion,
            genesisHash: genesis.hash,
            capturedAt: new Date().toISOString(),
            block: n.toString(),
            rawSource: 'reconstructed from JSON; pinned by hash in test/oracles.test.ts',
          },
          tx,
          receipt,
          simulate,
        },
        null,
        2,
      )}\n`,
    )
    captured.push(tx.hash)
    console.log(`block ${n}: ${tx.hash}`)
  }

  console.log(
    byHash
      ? `captured ${captured.length} frame transactions by hash`
      : `captured ${captured.length} frame transactions from blocks ${from}..${to}`,
  )
  if (captured.length === 0) console.warn('no type-0x06 transactions found — widen the range')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
