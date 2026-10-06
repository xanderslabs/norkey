/** An EIP-1193 provider error, the shape viem, wagmi and ethers expect on rejection. */
export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRpcError";
  }
}
