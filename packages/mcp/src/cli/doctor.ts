import { existsSync } from "node:fs";

import { VERSION, WALLET_FILE } from "../config.js";
import { loadSession } from "../connect/store.js";
import { readLegacyWalletPublicInfo } from "../wallet/index.js";
import {
  CLIENTS,
  detectInstalledClients,
  type ClientId,
} from "./install/clients.js";
import {
  inspectExistingMcp,
  requireRegistrationName,
  type ExistingMcpProbe,
} from "./install/collision.js";

export type LegacyRecoveryMaterialState =
  | "environment_material_present"
  | "wallet_file_public_recovery"
  | "not_present"
  | "wallet_file_unavailable";

export interface DoctorReport {
  readOnly: true;
  package: {
    version: string;
    channel: "stable" | "prerelease";
  };
  registrationName: string;
  clients: Array<{
    id: ClientId;
    name: string;
    probe: ExistingMcpProbe;
  }>;
  discovery: {
    searchAndCheckNeedWallet: false;
    searchAndCheckNeedFunding: false;
  };
  legacyRecovery: {
    material: LegacyRecoveryMaterialState;
    readOnly: true;
    paymentEnabled: false;
    signerLoaded: false;
    privateKeysReturned: false;
  };
  payment: {
    source: "hosted_governed_x402";
    connection: "connected" | "disconnected";
    authorityStatus: "not_checked";
    balanceChecked: false;
    localSignerExecutor: false;
    configurationIsApproval: false;
  };
  nextActions: string[];
}

interface DoctorOptions {
  client?: string;
  registrationName?: string;
  json?: boolean;
}

interface DoctorDependencies {
  detectClients?: () => ClientId[];
  inspectRegistration?: (
    client: ClientId,
    registrationName: string,
  ) => Promise<ExistingMcpProbe>;
  walletFile?: string;
  env?: NodeJS.ProcessEnv;
  connectedSession?: boolean;
}

export function inspectLegacyRecoveryMaterial(
  walletFile = WALLET_FILE,
  env: NodeJS.ProcessEnv = process.env,
): LegacyRecoveryMaterialState {
  const envNames = new Set(Object.keys(env));
  if (["DEXTER_PRIVATE_KEY", "SOLANA_PRIVATE_KEY", "EVM_PRIVATE_KEY"].some(
    (name) => envNames.has(name),
  )) {
    // Presence only: doctor never reads, parses, derives, or returns a key.
    return "environment_material_present";
  }
  if (!existsSync(walletFile)) return "not_present";
  return readLegacyWalletPublicInfo(walletFile)
    ? "wallet_file_public_recovery"
    : "wallet_file_unavailable";
}

export async function buildDoctorReport(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const registrationName = requireRegistrationName(
    options.registrationName ?? "opendexter",
  );
  let targets: ClientId[];
  if (options.client) {
    if (!Object.prototype.hasOwnProperty.call(CLIENTS, options.client)) {
      throw new Error(
        `Unknown client: ${options.client}. Available: ${Object.keys(CLIENTS).join(", ")}`,
      );
    }
    targets = [options.client as ClientId];
  } else {
    targets = (dependencies.detectClients ?? detectInstalledClients)();
  }
  const inspect = dependencies.inspectRegistration ?? inspectExistingMcp;
  const clients = await Promise.all(
    targets.map(async (id) => ({
      id,
      name: CLIENTS[id].name,
      probe: await inspect(id, registrationName),
    })),
  );
  const legacyRecoveryMaterial = inspectLegacyRecoveryMaterial(
    dependencies.walletFile ?? WALLET_FILE,
    dependencies.env ?? process.env,
  );
  const connectedSession = dependencies.connectedSession
    ?? loadSession() !== null;
  const nextActions: string[] = [];
  if (clients.length === 0) {
    nextActions.push(
      "No supported client was detected. Choose one explicitly with `opendexter install --client <name>`.",
    );
  }
  for (const client of clients) {
    if (client.probe.state === "absent") {
      nextActions.push(
        `Install ${registrationName} into ${client.name}; search and check need no funding.`,
      );
    } else if (client.probe.disposition === "upgrade_local") {
      nextActions.push(
        `Upgrade or intentionally replace the existing local ${registrationName} registration in ${client.name}.`,
      );
    } else if (client.probe.disposition === "replace_existing") {
      nextActions.push(
        `Keep the remote OpenDexter registration in ${client.name}, or remove it intentionally before installing local OpenDexter. An alias does not make both registrations safe.`,
      );
    } else {
      nextActions.push(
        `Inspect ${client.name}'s ${registrationName} registration manually; doctor left it unchanged.`,
      );
    }
  }
  if (legacyRecoveryMaterial === "wallet_file_public_recovery") {
    nextActions.push(
      "Legacy wallet.json material is available only through `opendexter wallet --legacy-recovery`, a read-only public-address and balance view; it is not a payment executor.",
    );
  } else if (legacyRecoveryMaterial === "environment_material_present") {
    nextActions.push(
      "Legacy signer environment variable names are present, but doctor did not read their values and the runtime will not use them as payment authority.",
    );
  } else if (legacyRecoveryMaterial === "wallet_file_unavailable") {
    nextActions.push(
      "A legacy wallet file exists but has no safe public recovery view. Doctor left it unchanged; the runtime will not repair, load, or execute it.",
    );
  }
  if (connectedSession) {
    nextActions.push(
      "Run `opendexter connect status` to verify the live hosted grant, limits, remaining capacity, expiry, scopes, active role, and revocation before relying on payment authority.",
    );
  } else {
    nextActions.push(
      "Run `opendexter connect` to approve the hosted governed x402 runtime. Local wallet.json and environment signers cannot execute payments.",
    );
  }
  nextActions.push(
    "Every paid call requires a connected hosted governed bearer, exact live bounded-authority evidence, an opaque checked intent, and the user-approved atomic ceiling.",
  );

  return {
    readOnly: true,
    package: {
      version: VERSION,
      channel: VERSION.includes("-") ? "prerelease" : "stable",
    },
    registrationName,
    clients,
    discovery: {
      searchAndCheckNeedWallet: false,
      searchAndCheckNeedFunding: false,
    },
    legacyRecovery: {
      material: legacyRecoveryMaterial,
      readOnly: true,
      paymentEnabled: false,
      signerLoaded: false,
      privateKeysReturned: false,
    },
    payment: {
      source: "hosted_governed_x402",
      connection: connectedSession ? "connected" : "disconnected",
      authorityStatus: "not_checked",
      balanceChecked: false,
      localSignerExecutor: false,
      configurationIsApproval: false,
    },
    nextActions,
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const report = await buildDoctorReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`OpenDexter ${report.package.version} (${report.package.channel})`);
  console.log("Doctor is read-only: no wallet was created, no balance was checked, and nothing was paid.");
  if (report.clients.length === 0) {
    console.log("Clients: none detected");
  } else {
    for (const client of report.clients) {
      console.log(
        `${client.name}: ${client.probe.state} (${client.probe.kind}; ${client.probe.disposition})`,
      );
    }
  }
  console.log(`Payment source: ${report.payment.source}`);
  console.log(`Hosted connection: ${report.payment.connection} (authority not checked)`);
  console.log(`Legacy recovery material: ${report.legacyRecovery.material} (read-only; not a payment executor)`);
  console.log("Search/check: no wallet or funding required");
  for (const action of report.nextActions) console.log(`- ${action}`);
  return report;
}
