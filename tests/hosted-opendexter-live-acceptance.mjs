import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const contractPath = resolve(
  repoRoot,
  "plugins/opendexter/skills/opendexter/references/hosted-contract.json",
);
const contract = JSON.parse(await readFile(contractPath, "utf8"));

const runEnabled = process.env.OPENDXTER_HOSTED_LIVE_RUN === "1";
const accessToken =
  process.env.OPENDXTER_HOSTED_LIVE_BEARER?.trim() || null;
const checkedUrlText =
  process.env.OPENDXTER_HOSTED_LIVE_QUOTE_URL?.trim() || null;
const requireConnected =
  process.env.OPENDXTER_HOSTED_LIVE_REQUIRE_CONNECTED === "1";

const forbiddenPublicKeys = new Set([
  "accesstoken",
  "apikey",
  "authtoken",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "internalrequestid",
  "linktoken",
  "mcpsessionid",
  "onetimecode",
  "otp",
  "password",
  "passphrase",
  "preparedid",
  "preparedpurchase",
  "privatekey",
  "rawchallenge",
  "requestbody",
  "routeid",
  "selectedrail",
  "sellerofferid",
  "sessionkey",
  "sessiontoken",
  "tabstate",
]);

const forbiddenGovernedArgumentKeys = new Set([
  "session",
  "sessionid",
  "mcpsessionid",
  "handle",
  "userhandle",
  "wallet",
  "walletaddress",
  "vault",
  "vaultpda",
  "actor",
  "actorid",
  "agent",
  "agentid",
  "grant",
  "grantid",
  "grantrevision",
  "linktoken",
  "linktokenid",
  "role",
  "authority",
  "authoritydigest",
  "authoritydecisiondigest",
  "decisiondigest",
  "mint",
  "symbol",
  "network",
  "program",
  "tokenprogram",
  "decimals",
]);

function normalizedKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sorted(values) {
  return [...values].sort();
}

function propertiesOf(schema) {
  return schema?.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties)
    : [];
}

function assertExactProperties(schema, expected, label) {
  assert.deepEqual(
    sorted(propertiesOf(schema)),
    sorted(expected),
    `${label} input fields drifted`,
  );
}

function assertStrictObject(schema, expectedProperties, expectedRequired, label) {
  assert.equal(schema?.type, "object", `${label} must be an object schema`);
  assert.equal(
    schema?.additionalProperties,
    false,
    `${label} must reject unknown fields`,
  );
  assertExactProperties(schema, expectedProperties, label);
  assert.deepEqual(
    sorted(schema.required ?? []),
    sorted(expectedRequired),
    `${label} required fields drifted`,
  );
}

function assertNoGovernedAuthorityFields(value, path = "inputSchema") {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoGovernedAuthorityFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties" && child && typeof child === "object") {
      for (const field of Object.keys(child)) {
        assert.equal(
          forbiddenGovernedArgumentKeys.has(normalizedKey(field)),
          false,
          `${path}.properties.${field} exposes model-supplied authority`,
        );
      }
    }
    assertNoGovernedAuthorityFields(child, `${path}.${key}`);
  }
}

function assertNoInternalKeys(value, path = "result") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInternalKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      forbiddenPublicKeys.has(normalizedKey(key)),
      false,
      `${path}.${key} leaked a credential or internal routing field`,
    );
    assertNoInternalKeys(child, `${path}.${key}`);
  }
}

function parseWire(text, contentType) {
  if (!text) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const messages = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
  assert.ok(messages.length > 0, "SSE response did not contain a JSON data event");
  return messages.at(-1);
}

function bearerHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseBearerChallenge(header) {
  assert.ok(header, "missing WWW-Authenticate challenge");
  assert.match(header, /^Bearer\s+/i);
  const params = {};
  const body = header.replace(/^Bearer\s+/i, "");
  const pattern = /([a-z_]+)="((?:[^"\\]|\\.)*)"|([a-z_]+)=([^,\s]+)/gi;
  for (const match of body.matchAll(pattern)) {
    const key = match[1] ?? match[3];
    const value = (match[2] ?? match[4])
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    params[key] = value;
  }
  return params;
}

function assertVaultChallengeHeader(header, label) {
  const params = parseBearerChallenge(header);
  for (const required of contract.mcp.challengeRequiredParameters) {
    assert.ok(params[required], `${label} challenge omitted ${required}`);
  }
  assert.equal(
    params.resource_metadata,
    contract.mcp.protectedResourceMetadata,
    `${label} challenge points at the wrong protected resource`,
  );
  assert.equal(params.scope, contract.mcp.scope, `${label} challenge scope drifted`);
  assert.ok(
    ["insufficient_scope", "invalid_token"].includes(params.error),
    `${label} challenge has an unsupported OAuth error`,
  );
}

function expectedTool(name) {
  const found = contract.tools.find((tool) => tool.name === name);
  assert.ok(found, `pinned contract has no ${name} descriptor`);
  return found;
}

function assertToolDescriptors(tools, expectedRoster, label) {
  assert.deepEqual(
    tools.map(({ name }) => name),
    expectedRoster,
    `${label} tool roster drifted`,
  );
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of expectedRoster) {
    const actual = byName[name];
    const expected = expectedTool(name);
    assert.deepEqual(
      actual.securitySchemes,
      expected.securitySchemes,
      `${name} top-level securitySchemes drifted`,
    );
    assert.deepEqual(
      actual._meta?.securitySchemes,
      expected.securitySchemes,
      `${name} _meta.securitySchemes drifted`,
    );
    assert.deepEqual(actual.annotations, expected.annotations, `${name} annotations drifted`);
    assert.deepEqual(
      actual._meta?.ui?.visibility,
      expected._meta?.ui?.visibility,
      `${name} visibility drifted`,
    );
    assert.equal(
      actual._meta?.["openai/widgetAccessible"],
      expected._meta?.["openai/widgetAccessible"],
      `${name} widget accessibility drifted`,
    );
    assert.ok(actual.inputSchema, `${name} omitted inputSchema`);
    assert.ok(actual.outputSchema, `${name} omitted outputSchema`);
  }
  for (const retired of contract.forbiddenHostedToolNames) {
    assert.equal(Object.hasOwn(byName, retired), false, `${label} revived ${retired}`);
  }
  for (const source of contract.forbiddenHostedToolPatterns) {
    const pattern = new RegExp(source);
    assert.equal(
      expectedRoster.some((name) => pattern.test(name)),
      false,
      `${label} revived a forbidden tool pattern ${source}`,
    );
  }
  return byName;
}

function assertCurrentInputSchemas(byName) {
  const ordinaryShapes = {
    x402_search: ["query", "network", "limit", "unverified", "testnets", "rerank"],
    x402_check: ["url", "method", "body"],
    x402_fetch: ["intentId", "maxAmountAtomic"],
    x402_status: ["intentId"],
    x402_access: ["url", "method", "body", "sessionToken", "sessionKey", "network"],
    x402_wallet: [],
    dexter_portfolio: [],
  };
  for (const [name, fields] of Object.entries(ordinaryShapes)) {
    assertExactProperties(byName[name].inputSchema, fields, name);
  }

  const prepare = byName.dexter_prepare_asset_action.inputSchema;
  const branches = prepare?.anyOf ?? prepare?.oneOf;
  assert.ok(Array.isArray(branches), "prepare must remain a strict action union");
  assert.equal(branches.length, 3, "prepare must expose Send, Buy, and Sell");
  const byAction = Object.fromEntries(
    branches.map((branch) => [branch?.properties?.action?.const, branch]),
  );
  assert.deepEqual(sorted(Object.keys(byAction)), ["buy", "sell", "send"]);
  assertStrictObject(
    byAction.send,
    ["operationId", "action", "assetId", "amountAtomic", "destinationOwner"],
    ["operationId", "action", "assetId", "amountAtomic", "destinationOwner"],
    "prepare/send",
  );
  for (const action of ["buy", "sell"]) {
    assertStrictObject(
      byAction[action],
      [
        "operationId",
        "action",
        "assetId",
        "amountAtomic",
        "memo",
        "maxSlippageBps",
        "maxPriceImpactBps",
      ],
      ["operationId", "action", "assetId", "amountAtomic"],
      `prepare/${action}`,
    );
  }
  assert.equal(byAction.send.properties.amountAtomic.maxLength, 20);
  assert.equal(byAction.send.properties.assetId.maxLength, 128);
  assert.equal(byAction.send.properties.destinationOwner.maxLength, 44);

  assertStrictObject(
    byName.dexter_execute_asset_action.inputSchema,
    ["operationId", "intentId"],
    ["operationId", "intentId"],
    "execute",
  );
  assertStrictObject(
    byName.dexter_asset_action_status.inputSchema,
    ["intentId"],
    ["intentId"],
    "status",
  );
  assertStrictObject(
    byName.dexter_reconcile_asset_action.inputSchema,
    ["intentId"],
    ["intentId"],
    "reconcile",
  );
  assertStrictObject(
    byName.dexter_wallet_history.inputSchema,
    ["limit", "cursor"],
    [],
    "history",
  );
  assert.equal(byName.dexter_wallet_history.inputSchema.properties.limit.maximum, 100);
  assert.equal(byName.dexter_wallet_history.inputSchema.properties.cursor.maxLength, 1024);

  for (const name of contract.oauthPromotedToolNames.filter((tool) =>
    tool.startsWith("dexter_"))) {
    assertNoGovernedAuthorityFields(byName[name].inputSchema, `${name}.inputSchema`);
  }

  assertExactProperties(
    byName.dexter_prepare_asset_action.outputSchema,
    [
      "namespace",
      "requestId",
      "executed",
      "attribution",
      "business",
      "status",
      "intentId",
      "planId",
      "replayed",
      "approval",
      "effectiveExpiresAt",
      "riskEvidenceDigest",
      "authoritySnapshotDigest",
      "preview",
      "account",
      "execution",
    ],
    "prepare output",
  );
  assertExactProperties(
    byName.dexter_execute_asset_action.outputSchema,
    [
      "namespace",
      "status",
      "requestId",
      "intentId",
      "attemptId",
      "transactionSignature",
      "executed",
      "code",
      "explanation",
      "attribution",
      "business",
      "evidenceDigest",
    ],
    "execute output",
  );
  assertExactProperties(
    byName.dexter_wallet_history.outputSchema,
    ["namespace", "items", "nextCursor"],
    "history output",
  );
  for (const field of [
    "namespace",
    "intentId",
    "action",
    "actor",
    "status",
    "ledgerState",
    "receiptPhases",
    "canReconcile",
  ]) {
    assert.ok(
      Object.hasOwn(byName.dexter_asset_action_status.outputSchema.properties, field),
      `status output omitted ${field}`,
    );
  }
}

function validatePinnedContract() {
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.contractId, "opendexter-hosted-twelve-tool-v1");
  assert.equal(new URL(contract.mcp.url).protocol, "https:");
  assert.equal(contract.mcp.resource, contract.mcp.url);
  assert.equal(contract.anonymousToolNames.length, 5);
  assert.equal(contract.oauthPromotedToolNames.length, 7);
  assert.equal(contract.connectedToolNames.length, 12);
  assert.deepEqual(
    contract.tools.map(({ name }) => name),
    contract.connectedToolNames,
  );
  assert.deepEqual(
    sorted(new Set([
      ...contract.anonymousToolNames,
      ...contract.oauthPromotedToolNames,
    ])),
    sorted(contract.connectedToolNames),
  );
}

const endpoint = contract.mcp.url;

async function request({ body, sessionId = null, token = null }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...bearerHeaders(token),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    cacheControl: response.headers.get("cache-control"),
    wwwAuthenticate: response.headers.get("www-authenticate"),
    message: parseWire(text, response.headers.get("content-type") ?? ""),
  };
}

async function initialize() {
  const response = await request({
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "opendexter-hosted-live-acceptance",
          version: "2.0.0",
        },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.ok(response.sessionId, "initialize did not return mcp-session-id");
  assert.equal(response.message?.result?.serverInfo?.name, "OpenDexter");
  assert.equal(
    response.message?.result?.serverInfo?.version,
    contract.mcp.manifestVersion,
  );
  const initialized = await request({
    sessionId: response.sessionId,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.ok(
    [200, 202, 204].includes(initialized.status),
    `notifications/initialized returned HTTP ${initialized.status}`,
  );
  return response.sessionId;
}

async function rpcRaw(sessionId, id, method, params = {}, token = null) {
  return await request({
    token,
    sessionId,
    body: { jsonrpc: "2.0", id, method, params },
  });
}

async function rpc(sessionId, id, method, params = {}, token = null) {
  const response = await rpcRaw(sessionId, id, method, params, token);
  assert.equal(
    response.status,
    200,
    `${method} returned HTTP ${response.status}: ${response.wwwAuthenticate ?? "no challenge"}`,
  );
  assert.equal(response.message?.jsonrpc, "2.0");
  assert.equal(response.message?.id, id);
  assert.equal(response.message?.error, undefined, JSON.stringify(response.message?.error));
  return response.message.result;
}

async function listTools(sessionId, id, token = null) {
  const result = await rpc(sessionId, id, "tools/list", {}, token);
  assert.ok(Array.isArray(result.tools));
  return result.tools;
}

async function callTool(sessionId, id, name, args, token = null) {
  return await rpc(
    sessionId,
    id,
    "tools/call",
    { name, arguments: args },
    token,
  );
}

function assertToolLevelAuthChallenge(result, tool) {
  assert.equal(result.isError, true, `${tool} should challenge before OAuth`);
  assert.equal(result.structuredContent?.mode, "authentication_required");
  assert.equal(result.structuredContent?.user_bound, false);
  assert.equal(result.structuredContent?.status, 401);
  assert.equal(result.structuredContent?.next_action, "connect_opendexter");
  assert.notEqual(
    result.structuredContent?.reason,
    "not_enrolled",
    `${tool} cannot claim wallet non-enrollment before connector OAuth`,
  );
  const challenges = result._meta?.["mcp/www_authenticate"];
  assert.ok(Array.isArray(challenges) && challenges.length === 1);
  assertVaultChallengeHeader(challenges[0], tool);
}

function assertTransportAuthChallenge(response, tool) {
  assert.equal(response.status, 401, `${tool} must be challenged before dispatch`);
  assert.equal(response.cacheControl, "no-store");
  assert.equal(response.message?.jsonrpc, "2.0");
  assert.equal(response.message?.id, null);
  assert.equal(response.message?.error?.code, -32001);
  assert.equal(response.message?.error?.message, "authentication required");
  assertVaultChallengeHeader(response.wwwAuthenticate, tool);
}

async function metadataAcceptance() {
  let canonicalResource = null;
  for (const path of contract.mcp.protectedResourcePaths) {
    const response = await fetch(new URL(path, endpoint), {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `${path} metadata unavailable`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const resource = await response.json();
    assert.equal(resource.resource, contract.mcp.resource);
    assert.deepEqual(resource.authorization_servers, [contract.mcp.authorizationServer]);
    assert.ok(resource.scopes_supported.includes(contract.mcp.scope));
    if (canonicalResource) assert.deepEqual(resource, canonicalResource);
    canonicalResource = resource;
  }

  const asResponse = await fetch(contract.mcp.authorizationServerMetadata, {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(asResponse.status, 200);
  const authorizationServer = await asResponse.json();
  assert.equal(authorizationServer.issuer, contract.mcp.authorizationServer);
  assert.ok(authorizationServer.code_challenge_methods_supported.includes("S256"));
  assert.ok(authorizationServer.scopes_supported.includes(contract.mcp.scope));
}

async function anonymousAcceptance(checkedUrl) {
  const sessionId = await initialize();
  const tools = await listTools(sessionId, 2);
  assertToolDescriptors(tools, contract.anonymousToolNames, "anonymous");

  const search = await callTool(sessionId, 3, "x402_search", {
    query: "a reliable API for current cryptocurrency prices",
    limit: 5,
  });
  assert.notEqual(search.isError, true);
  const searchBody = search.structuredContent;
  const results = [
    ...(searchBody?.strongResults ?? []),
    ...(searchBody?.relatedResults ?? []),
  ];
  assert.ok(results.length > 0, "live discovery returned no results");
  assert.ok(results.some((entry) => entry.verified === true));
  assert.equal(searchBody?.providerDataPolicy?.mayAuthorizePayment, false);

  const check = await callTool(sessionId, 4, "x402_check", {
    url: checkedUrl.href,
    method: "GET",
  });
  assert.notEqual(check.isError, true);
  assert.equal(check.structuredContent?.authMode, "paid");
  assert.equal(check.structuredContent?.quoteOnly, true);
  assert.equal(check.structuredContent?.intentId, null);
  assert.equal(check.structuredContent?.checkedRequest?.url, checkedUrl.href);
  assert.equal(check.structuredContent?.checkedRequest?.method, "GET");
  assert.equal(check.structuredContent?.checkedRequest?.requestBound, true);
  assert.ok(check.structuredContent?.paymentOptions?.length > 0);
  assertNoInternalKeys(check.structuredContent);

  const wallet = await callTool(sessionId, 5, "x402_wallet", {});
  assertToolLevelAuthChallenge(wallet, "x402_wallet");
  const portfolio = await callTool(sessionId, 6, "dexter_portfolio", {});
  assertToolLevelAuthChallenge(portfolio, "dexter_portfolio");

  const governedRead = await rpcRaw(
    sessionId,
    7,
    "tools/call",
    { name: "dexter_wallet_history", arguments: { limit: 1 } },
  );
  assertTransportAuthChallenge(governedRead, "dexter_wallet_history");

  return {
    serverVersion: contract.mcp.manifestVersion,
    anonymousTools: tools.map(({ name }) => name),
    discoveryResults: results.length,
    quotedOptions: check.structuredContent.paymentOptions.length,
    connectChallenges: {
      toolLevel: ["x402_wallet", "dexter_portfolio"],
      transportLevel: ["dexter_wallet_history"],
    },
  };
}

function assertPortfolio(portfolio) {
  const body = portfolio.structuredContent;
  assert.notEqual(portfolio.isError, true, JSON.stringify(body));
  assert.equal(body?.mode, "portfolio_ready");
  assert.equal(body?.user_bound, true);
  assert.equal(body?.portfolio?.contractVersion, "opendexter.portfolio.v1");
  assert.equal(body?.portfolio?.network, "solana-mainnet");
  assert.equal(body?.portfolio?.holdingsComplete, true);
  assert.ok(Array.isArray(body?.portfolio?.holdings));
  for (const holding of body.portfolio.holdings) {
    if (holding.approvalStatus === "approved") {
      assert.match(holding.assetId, /^[a-z0-9][a-z0-9._:-]{0,127}$/);
    } else {
      assert.equal(holding.assetId, null);
    }
  }
  assertNoInternalKeys(body);
}

function assertGovernedHistory(history) {
  const body = history.structuredContent;
  assert.notEqual(history.isError, true, JSON.stringify(body));
  assert.equal(body?.namespace, "dexter-governed-transaction-history/v1");
  assert.ok(Array.isArray(body?.items));
  assert.ok(body.items.length <= 1);
  assert.ok(body.nextCursor === null || typeof body.nextCursor === "string");
  for (const item of body.items) {
    assert.equal(item.namespace, "dexter-governed-transaction-status/v1");
    assert.match(item.intentId, /^[0-9a-f-]{36}$/i);
    assert.ok(["send", "buy", "sell"].includes(item.action));
    assert.ok(["owner", "agent"].includes(item.actor));
    assert.equal(item.replay?.statusReadSafe, true);
    assert.equal(item.replay?.executeFromStatusForbidden, true);
  }
  assertNoInternalKeys(body);
}

async function connectedAcceptance(token, checkedUrl) {
  const sessionId = await initialize();
  const tools = await listTools(sessionId, 20, token);
  const byName = assertToolDescriptors(
    tools,
    contract.connectedToolNames,
    "connected",
  );
  assertCurrentInputSchemas(byName);

  const wallet = await callTool(sessionId, 21, "x402_wallet", {}, token);
  assert.notEqual(wallet.isError, true, JSON.stringify(wallet.structuredContent));
  assert.equal(wallet.structuredContent?.user_bound, true);
  assert.ok(wallet.structuredContent?.address, "wallet omitted its receive address");
  assert.equal(wallet.structuredContent?.solanaAddress, wallet.structuredContent.address);
  assert.equal(wallet.structuredContent?.vault?.receiveAddress, wallet.structuredContent.address);
  assertNoInternalKeys(wallet.structuredContent);

  const portfolio = await callTool(sessionId, 22, "dexter_portfolio", {}, token);
  assertPortfolio(portfolio);

  const check = await callTool(
    sessionId,
    23,
    "x402_check",
    { url: checkedUrl.href, method: "GET" },
    token,
  );
  assert.notEqual(check.isError, true, JSON.stringify(check.structuredContent));
  assert.equal(check.structuredContent?.authMode, "paid");
  assert.equal(check.structuredContent?.quoteOnly, false);
  assert.ok(check.structuredContent?.intentId);
  assert.equal(check.structuredContent?.checkedRequest?.url, checkedUrl.href);
  assert.equal(check.structuredContent?.executionGuidance?.readyForFetch, true);
  assert.deepEqual(
    check.structuredContent?.executionGuidance?.fetchArguments,
    ["intentId", "maxAmountAtomic"],
  );
  assertNoInternalKeys(check.structuredContent);

  const status = await callTool(
    sessionId,
    24,
    "x402_status",
    { intentId: check.structuredContent.intentId },
    token,
  );
  assert.notEqual(status.isError, true, JSON.stringify(status.structuredContent));
  assert.equal(status.structuredContent?.intentId, check.structuredContent.intentId);
  assertNoInternalKeys(status.structuredContent);

  const history = await callTool(
    sessionId,
    25,
    "dexter_wallet_history",
    { limit: 1 },
    token,
  );
  assertGovernedHistory(history);

  return {
    connectedTools: tools.map(({ name }) => name),
    walletBound: true,
    portfolioHoldings: portfolio.structuredContent.portfolio.holdings.length,
    x402IntentCreated: true,
    x402StatusRead: true,
    governedHistoryRead: true,
  };
}

async function main() {
  validatePinnedContract();
  assert.ok(
    checkedUrlText,
    "OPENDXTER_HOSTED_LIVE_QUOTE_URL must name a current approved paid GET endpoint",
  );
  const checkedUrl = new URL(checkedUrlText);
  assert.equal(checkedUrl.protocol, "https:", "quote target must use HTTPS");
  if (requireConnected) {
    assert.ok(
      accessToken,
      "OPENDXTER_HOSTED_LIVE_REQUIRE_CONNECTED=1 requires OPENDXTER_HOSTED_LIVE_BEARER",
    );
  }

  await metadataAcceptance();
  const anonymous = await anonymousAcceptance(checkedUrl);
  const connected = accessToken
    ? await connectedAcceptance(accessToken, checkedUrl)
    : { skipped: "set OPENDXTER_HOSTED_LIVE_BEARER for connected acceptance" };

  console.log(JSON.stringify({
    ok: true,
    complete: Boolean(accessToken),
    contractId: contract.contractId,
    sourceCommit: contract.source.commit,
    endpoint,
    anonymous,
    connected,
  }, null, 2));
}

if (!runEnabled) {
  console.error(
    "Refusing hosted network calls. Set OPENDXTER_HOSTED_LIVE_RUN=1 only for an authorized live acceptance run.",
  );
  process.exitCode = 2;
} else {
  await main();
}
