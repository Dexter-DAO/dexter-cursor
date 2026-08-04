import { existsSync, readFileSync } from "node:fs";

import { VERSION, WALLET_FILE } from "../config.js";
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

export type SignerConfigurationState =
  | "environment"
  | "local_file"
  | "not_configured"
  | "invalid_local_file";

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
  payment: {
    signerConfiguration: SignerConfigurationState;
    balanceChecked: false;
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
}

export function inspectSignerConfiguration(
  walletFile = WALLET_FILE,
  env: NodeJS.ProcessEnv = process.env,
): SignerConfigurationState {
  if (
    (typeof (env.DEXTER_PRIVATE_KEY ?? env.SOLANA_PRIVATE_KEY) === "string"
      && Boolean((env.DEXTER_PRIVATE_KEY ?? env.SOLANA_PRIVATE_KEY)?.trim()))
    || (typeof env.EVM_PRIVATE_KEY === "string"
      && Boolean(env.EVM_PRIVATE_KEY.trim()))
  ) {
    return "environment";
  }
  if (!existsSync(walletFile)) return "not_configured";
  try {
    const parsed = JSON.parse(readFileSync(walletFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "invalid_local_file";
    }
    const record = parsed as Record<string, unknown>;
    return [record.solanaPrivateKey, record.evmPrivateKey].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
      ? "local_file"
      : "invalid_local_file";
  } catch {
    return "invalid_local_file";
  }
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
  const signerConfiguration = inspectSignerConfiguration(
    dependencies.walletFile ?? WALLET_FILE,
    dependencies.env ?? process.env,
  );
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
  if (signerConfiguration === "not_configured") {
    nextActions.push(
      "No signer is configured. That does not block search or check; configure one only before Direct Exact payment.",
    );
  } else if (signerConfiguration === "invalid_local_file") {
    nextActions.push(
      "The local signer file is unreadable or incomplete. Search and check still work; repair it before Direct Exact payment.",
    );
  }
  nextActions.push(
    "A configured signer or ready credit adapter is capability, not authorization. Every paid call still needs the exact prepared purchase and atomic ceiling authorized by the user's instruction or delegated policy.",
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
    payment: {
      signerConfiguration,
      balanceChecked: false,
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
  console.log(`Signer configuration: ${report.payment.signerConfiguration}`);
  console.log("Search/check: no wallet or funding required");
  for (const action of report.nextActions) console.log(`- ${action}`);
  return report;
}
