import type {
  FrameAccount,
  FrameAccountImplementation,
} from './types.js'

export type ToFrameAccountParameters<
  implementation extends
    FrameAccountImplementation = FrameAccountImplementation,
> = implementation

export type ToFrameAccountReturnType<
  implementation extends
    FrameAccountImplementation = FrameAccountImplementation,
> = FrameAccount<implementation>

/** Resolve an account implementation into the object consumed by frame actions. */
export async function toFrameAccount<
  const implementation extends FrameAccountImplementation,
>(
  implementation: ToFrameAccountParameters<implementation>,
): Promise<ToFrameAccountReturnType<implementation>> {
  const { extend, ...rest } = implementation
  const address = await implementation.getAddress()

  return {
    ...extend,
    ...rest,
    address,
    type: 'frame',
  } as ToFrameAccountReturnType<implementation>
}
