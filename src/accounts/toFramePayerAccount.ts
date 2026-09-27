import type {
  FramePayerAccount,
  FramePayerAccountImplementation,
} from './types.js'

export type ToFramePayerAccountParameters<
  implementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = implementation

export type ToFramePayerAccountReturnType<
  implementation extends
    FramePayerAccountImplementation = FramePayerAccountImplementation,
> = FramePayerAccount<implementation>

/** Resolve a payer implementation into the object consumed by frame actions. */
export async function toFramePayerAccount<
  const implementation extends FramePayerAccountImplementation,
>(
  implementation: ToFramePayerAccountParameters<implementation>,
): Promise<ToFramePayerAccountReturnType<implementation>> {
  const { extend, ...rest } = implementation
  const address = await implementation.getAddress()

  return {
    ...extend,
    ...rest,
    address,
    type: 'framePayer',
  } as ToFramePayerAccountReturnType<implementation>
}
