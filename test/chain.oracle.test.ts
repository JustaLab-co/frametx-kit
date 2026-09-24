import { keccak256 } from 'viem'
import { describe, expect, test } from 'vitest'
import { decodeFrameTx, encodeFrameTx } from '../src/envelope.js'
import { frameTxGas, frameTxMaxCost } from '../src/gas.js'
import { parseRpcFrameReceipt, parseRpcFrameTransaction } from '../src/rpc.js'
import { recoverFrameSigner, resolveSigner } from '../src/signatures.js'
import { loadChainFixtures } from './helpers/fixtures.js'

// Each fixture carries its own hash, receipt and simulate answer, so these checks
// need no network and keep holding after the chain re-genesises.
const fixtures = loadChainFixtures()
const cases = fixtures.map((f) => [f.name, f] as const)

describe('captured chain fixtures', () => {
  test('exist', () => expect(fixtures.length).toBeGreaterThan(0))
})

// The node's decoded JSON, re-encoded, must hash to the node's hash.
describe.each(cases)('wire format: %s', (_name, fixture) => {
  const tx = parseRpcFrameTransaction(fixture.tx)
  const raw = encodeFrameTx(tx)

  test('re-encoding reproduces the transaction hash', () => {
    expect(keccak256(raw)).toBe(fixture.tx.hash)
  })

  test('the reproduced bytes decode back to the parsed transaction', () => {
    expect(decodeFrameTx(raw)).toEqual(tx)
  })
})

// Real signatures, real receipts, and the node's own maxCost.
describe.each(cases)('signatures and gas: %s', (_name, fixture) => {
  const tx = parseRpcFrameTransaction(fixture.tx)

  test('every SECP256K1 signature recovers to its resolved signer', async () => {
    for (const [i, sig] of tx.signatures.entries())
      if (sig.scheme === 1) expect(await recoverFrameSigner(tx, i)).toBe(resolveSigner(tx, i))
  })

  test('the node authenticates our sig_hash over the real signature', () => {
    expect(fixture.simulate.violation ?? '').not.toMatch(/does not authenticate/)
  })

  test("our maxCost equals the node's", () => {
    // Blob-free on this chain so far; the blob term needs the base fee at capture.
    expect(tx.blobVersionedHashes).toEqual([])
    expect(frameTxMaxCost(tx, 0n, 'chain')).toBe(BigInt(fixture.simulate.maxCost))
  })

  // The calldata floor binds the regular dimension only; state gas goes on top.
  // Storage refunds are not itemized in frame receipts, so fixtures are chosen
  // from refund-free transactions and this stays an equality.
  test('gasUsed = max(intrinsic + sum of frame execution, floor) + sum of frame state', () => {
    const gas = frameTxGas(tx, 'chain')
    const { frameReceipts } = parseRpcFrameReceipt(fixture.receipt)
    const execution = frameReceipts.reduce((acc, f) => acc + f.gasUsed, 0n)
    const state = frameReceipts.reduce((acc, f) => acc + f.stateGasUsed, 0n)
    const regular = gas.intrinsicGas + execution
    const floored = regular > gas.calldataFloorTotal ? regular : gas.calldataFloorTotal
    expect(floored + state).toBe(BigInt(fixture.receipt.gasUsed))
  })
})
