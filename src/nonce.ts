import {
  type Address,
  type BlockTag,
  type EIP1193RequestFn,
  type Hex,
  concatHex,
  keccak256,
  numberToHex,
  pad,
} from 'viem'
import { FrameEncodeError } from './errors.js'

/** EIP-8250 `NONCE_MANAGER` predeploy. Holds the sequence of every non-zero nonce key. */
export const NONCE_MANAGER: Address = '0x0000000000000000000000000000000000008250'

const U256_MAX = 2n ** 256n - 1n

/**
 * The `NONCE_MANAGER` storage slot of `(sender, key)`:
 * `keccak256(left_pad_32(sender) || uint256_to_bytes32(key))`
 * (ethrex `docs/eip-8250.md:34`, `VM::keyed_nonce_slot`).
 */
export function keyedNonceSlot(sender: Address, key: bigint): Hex {
  if (key <= 0n || key > U256_MAX)
    throw new FrameEncodeError(`a keyed nonce slot needs a key in 1..2**256 - 1, got ${key}`)
  return keccak256(concatHex([pad(sender, { size: 32 }), numberToHex(key, { size: 32 })]))
}

export type GetFrameNonceSeqParameters = {
  address: Address
  /** Nonce key to read. Defaults to `0n`, the account nonce. */
  key?: bigint | undefined
  blockTag?: BlockTag | undefined
}

/**
 * The current EIP-8250 sequence of one nonce key: what `nonceSeq` must equal for
 * a transaction selecting that key.
 *
 * Key `0` is the account nonce, read with `eth_getTransactionCount`. Any other
 * key is a `NONCE_MANAGER` storage slot, read with `eth_getStorageAt`; the node
 * has no RPC for keyed nonces, and an unused key reads zero.
 */
export async function getFrameNonceSeq(
  client: { request: EIP1193RequestFn },
  { address, key = 0n, blockTag = 'pending' }: GetFrameNonceSeqParameters,
): Promise<bigint> {
  if (key === 0n) {
    const count = (await client.request({
      method: 'eth_getTransactionCount',
      params: [address, blockTag],
    })) as Hex
    return BigInt(count)
  }
  const value = (await client.request({
    method: 'eth_getStorageAt',
    params: [NONCE_MANAGER, keyedNonceSlot(address, key), blockTag],
  })) as Hex
  return BigInt(value)
}
