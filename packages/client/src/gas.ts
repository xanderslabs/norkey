import type { Address, Hex, PublicClient } from "viem";
import { type Call, encodeExecute } from "./calibur.js";

/** Gas reserved for one EIP-7702 authorization. EIP-7702 sets 25,000 (PER_EMPTY_ACCOUNT_COST), but
 *  Sepolia measured about 43,350 on 2026-10-13 (NorKey-internal/probes/gas-estimate.md). Too little
 *  runs the first send out of gas; too much is refunded. */
const AUTH_GAS = 50_000n;
/** Fallback when no state override works. Unused gas is refunded; the sender must hold gas * maxFee. */
const FALLBACK_FLOOR = 1_000_000n;
/** From NorKey-internal/probes/gas-estimate.md (Task 0). */
const OVERRIDE_FORM: "designator" | "runtime-code" | "none" = "designator";

async function overrideCode(client: PublicClient, calibur: Address): Promise<Hex | undefined> {
  if (OVERRIDE_FORM === "designator") return `0xef0100${calibur.slice(2)}`;
  if (OVERRIDE_FORM === "runtime-code") return client.getCode({ address: calibur });
  return undefined;
}

/**
 * Gas for the transaction the boundary page will sign (see page/calls.ts). An undelegated account
 * has no code, so a plain estimate of the batch would cover a call to an empty account. The estimate
 * runs with Calibur's code overridden in, plus the authorization's intrinsic gas.
 */
export async function estimateCallsGas(
  client: PublicClient,
  a: { from: Address; calls: Call[]; delegate: boolean; calibur: Address },
): Promise<bigint> {
  if (!a.delegate && a.calls.length === 1) {
    const [c] = a.calls;
    return client.estimateGas({ account: a.from, to: c.to, value: c.value, data: c.data });
  }
  const data = encodeExecute(a.calls);
  if (!a.delegate) return client.estimateGas({ account: a.from, to: a.from, data });
  const code = await overrideCode(client, a.calibur).catch(() => undefined);
  if (code) {
    try {
      const gas = await client.estimateGas({
        account: a.from,
        to: a.from,
        data,
        stateOverride: [{ address: a.from, code }],
      });
      return gas + AUTH_GAS;
    } catch {
      // Fall through to the buffered estimate.
    }
  }
  const plain = await client.estimateGas({ account: a.from, to: a.from, data });
  const buffered = (plain + AUTH_GAS) * 2n;
  return buffered > FALLBACK_FLOOR ? buffered : FALLBACK_FLOOR;
}
