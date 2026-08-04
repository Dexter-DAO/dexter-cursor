import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkEndpointPricing, type CheckResult } from "@dexterai/x402-core";
import type { CheckToolOpts } from "../types.js";
import {
  PURCHASE_CONTRACT_VERSION,
  buildPurchaseOptions,
  type PurchaseAvailability,
  type PreparedPurchaseOptionV1,
} from "../purchase-contract.js";

const LOCAL_DIRECT_EVM_NETWORKS = new Set([
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
  "avalanche-c",
  "bsc",
  "eip155:8453",
  "eip155:137",
  "eip155:42161",
  "eip155:10",
  "eip155:43114",
  "eip155:56",
  "eip155:1187947933",
]);
const MAX_DURABLE_PREPARATIONS_PER_CHECK = 16;
const PUBLIC_GATEWAY_REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;
const NON_READY_GATEWAY_STATES = new Set([
  "integration_required",
  "request_required",
  "unavailable",
]);

function validGatewayAvailability(value: unknown): PurchaseAvailability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "ready" && candidate.reason === null) {
    return { state: "ready", reason: null };
  }
  if (
    typeof candidate.state === "string"
    && NON_READY_GATEWAY_STATES.has(candidate.state)
    && typeof candidate.reason === "string"
    && PUBLIC_GATEWAY_REASON_RE.test(candidate.reason)
  ) {
    return {
      state: candidate.state as Exclude<PurchaseAvailability["state"], "ready">,
      reason: candidate.reason,
    };
  }
  return null;
}

function directNetworkFamily(
  network: string,
): "solana" | "evm" | "unsupported" {
  const normalized = network.trim().toLowerCase();
  if (
    normalized === "solana"
    || normalized === "svm"
    || normalized.startsWith("solana:")
  ) {
    return "solana";
  }
  return LOCAL_DIRECT_EVM_NETWORKS.has(normalized) ? "evm" : "unsupported";
}

function downgraded(
  option: PreparedPurchaseOptionV1,
  state: "integration_required" | "unavailable",
  reason: string,
): PreparedPurchaseOptionV1 {
  return {
    ...option,
    availability: { state, reason },
  };
}

/**
 * Turn contract-level options into truthful executable options for this
 * concrete local consumer. A mode is ready only after its executor and wallet
 * capabilities are present and its exact prepared identity is durable.
 */
export function preparePurchaseOptionsForCapabilities(
  options: PreparedPurchaseOptionV1[],
  capabilities: Pick<
    CheckToolOpts,
    | "wallet"
    | "getTabLane"
    | "getGatewayPurchaseAdapter"
    | "getPurchaseAttemptStore"
  >,
): PreparedPurchaseOptionV1[] {
  let store:
    | NonNullable<ReturnType<NonNullable<CheckToolOpts["getPurchaseAttemptStore"]>>>
    | null = null;
  try {
    store = capabilities.getPurchaseAttemptStore?.() ?? null;
  } catch {
    store = null;
  }
  if (!store || typeof store.prepare !== "function") {
    store = null;
  }

  let tabLaneAvailable = false;
  try {
    tabLaneAvailable =
      typeof capabilities.getTabLane?.() === "function";
  } catch {
    tabLaneAvailable = false;
  }

  let paymentSigners: ReturnType<
    NonNullable<CheckToolOpts["wallet"]>["getPaymentSigners"]
  > | null = null;
  try {
    paymentSigners =
      capabilities.wallet?.getPaymentSigners() ?? null;
  } catch {
    paymentSigners = null;
  }

  let durablePreparationCount = 0;
  return options.map((option) => {
    let candidate = option;
    if (
      option.mode === "gateway_cash"
      || option.mode === "gateway_credit"
    ) {
      // `request_required` is load-bearing: an adapter cannot make an
      // unpriced request executable. It may only replace the contract's
      // default integration_required state with fresh capability truth.
      if (option.availability.state !== "integration_required") return option;
      let availability: PurchaseAvailability = option.availability;
      try {
        const adapter = capabilities.getGatewayPurchaseAdapter?.(option.mode);
        if (
          adapter
          && adapter.mode === option.mode
          && typeof adapter.readiness === "function"
          && typeof adapter.execute === "function"
        ) {
          availability = validGatewayAvailability(
            adapter.readiness(option.preparedPurchase),
          ) ?? {
            state: "integration_required",
            reason: "gateway_adapter_readiness_invalid",
          };
        }
      } catch {
        availability = {
          state: "integration_required",
          reason: "gateway_adapter_readiness_failed",
        };
      }
      candidate = { ...option, availability };
    }

    if (candidate.availability.state !== "ready") return candidate;

    if (candidate.mode === "direct_exact") {
      const family = directNetworkFamily(
        candidate.preparedPurchase.route.sellerOffer.network,
      );
      if (family === "unsupported") {
        return downgraded(
          candidate,
          "unavailable",
          "local_direct_network_not_supported",
        );
      }
      const signerPresent =
        family === "solana"
          ? Boolean(paymentSigners?.solanaPrivateKey)
          : Boolean(paymentSigners?.evmPrivateKey);
      if (!signerPresent) {
        return downgraded(
          candidate,
          "unavailable",
          family === "solana"
            ? "local_direct_solana_wallet_required"
            : "local_direct_evm_wallet_required",
        );
      }
    }

    if (candidate.mode === "native_tab" && !tabLaneAvailable) {
      return downgraded(
        candidate,
        "integration_required",
        "local_native_tab_adapter_required",
      );
    }

    if (!store) {
      return downgraded(
        candidate,
        "integration_required",
        "durable_purchase_preparation_store_required",
      );
    }
    if (durablePreparationCount >= MAX_DURABLE_PREPARATIONS_PER_CHECK) {
      return downgraded(
        candidate,
        "unavailable",
        "prepared_purchase_option_limit_exceeded",
      );
    }
    durablePreparationCount += 1;
    try {
      store.prepare(candidate.preparedPurchase);
      return candidate;
    } catch {
      return downgraded(
        candidate,
        "integration_required",
        "durable_purchase_preparation_failed",
      );
    }
  });
}

/**
 * x402_check tool registration.
 *
 * Thin adapter over @dexterai/x402-core's checkEndpointPricing(). All probe
 * logic, schema extraction, and authMode classification live in x402-core —
 * this file owns the MCP-side surface (name, description, Zod schema,
 * widget metadata binding). Matches the hosted server's behavior so both
 * surfaces return identical `inputSchema`, `outputSchema`, and `authMode`.
 */
export function registerCheckTool(server: McpServer, opts: CheckToolOpts): void {
  const meta = opts.metas.check;

  server.registerTool(
    "x402_check",
    {
      description:
        "Probe an endpoint for x402 payment requirements without paying. " +
        "Returns lossless seller terms and explicit purchaseOptions for direct_exact, native_tab, gateway_cash, and gateway_credit, including each mode's availability. " +
        "Each prepared option pins the URL, method, request digest, seller offer, route, network, asset, atomic amount, and prepared identity. " +
        "input/output body schemas when the endpoint publishes them, and an authMode classification " +
        "(`paid`, `siwx`, `apiKey`, `apiKey+paid`, `unprotected`, or `unknown`). " +
        "Use this before x402_fetch to select one exact route without paying, " +
        "and before x402_access to detect whether identity gating applies.",
      inputSchema: {
        url: z.string().url().describe("The URL to check"),
        method: z
          .enum(["GET", "POST", "PUT", "DELETE"])
          .default("GET")
          .describe("HTTP method to probe with"),
        sampleInputBody: z
          .record(z.unknown())
          .optional()
          .describe(
            "Exact request body used for input-dependent POST/PUT/DELETE pricing. " +
              "Without this, a non-GET quote is indicative and cannot become a prepared purchase.",
          ),
      },
      _meta: meta,
    },
    async (args) => {
      try {
        const result: CheckResult = await checkEndpointPricing(args);
        const method = args.method || "GET";
        const payload =
          method === "GET" ? null : JSON.stringify(args.sampleInputBody ?? {});
        const purchaseOptions = preparePurchaseOptionsForCapabilities(
          buildPurchaseOptions({
            checkResult: result,
            url: args.url,
            method,
            payload,
            requestBound:
              method === "GET" ||
              Object.prototype.hasOwnProperty.call(args, "sampleInputBody"),
            surface: "local",
          }),
          opts,
        );
        const merged = {
          ...result,
          purchaseContractVersion: PURCHASE_CONTRACT_VERSION,
          preparedPayload: payload,
          purchaseOptions,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(merged, null, 2) }],
          structuredContent: merged as unknown as Record<string, unknown>,
          _meta: meta,
        } as any;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    },
  );
}
