// Test-only: Pimlico's mock ERC-7677 paymaster on the anvil fork, for the sponsored journey. It
// deploys a v0.8 singleton paymaster on the fork, sponsors every operation, and forwards every
// non-pm_* method to Alto, so one URL serves both, as Pimlico's hosted API does.
import { paymaster } from "@pimlico/mock-paymaster";

await paymaster({ anvilRpc: "http://127.0.0.1:8545", altoRpc: "http://127.0.0.1:4337", port: 3333 }).start();
console.log("mock paymaster on :3333");
