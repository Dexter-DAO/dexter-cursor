#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultCasesPath = resolve(here, "opendexter-novice-routing-cases.json");
const TOOL_NAME = /\b(?:indexter_[a-z_]+|x402_[a-z_]+|dexter_[a-z_]+)\b/i;
const MAGIC_LANGUAGE = /\b(?:intentId|operationId|maxAmountAtomic|amountAtomic|tool name|call the tool)\b/i;

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

export function validateCases(suite) {
  if (suite?.schemaVersion !== 1 || suite?.kind !== "opendexter-novice-routing-cases/v1") {
    fail("unexpected novice-routing suite schema");
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) fail("routing suite is empty");
  const ids = new Set();
  for (const entry of suite.cases) {
    if (typeof entry.id !== "string" || !entry.id) fail("case id is required");
    if (ids.has(entry.id)) fail(`duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    if (!["hosted-anonymous", "hosted-connected", "local"].includes(entry.surface)) {
      fail(`${entry.id}: unknown surface`);
    }
    if (typeof entry.prompt !== "string" || entry.prompt.length < 20) {
      fail(`${entry.id}: prompt is not realistic user language`);
    }
    if (TOOL_NAME.test(entry.prompt) || MAGIC_LANGUAGE.test(entry.prompt)) {
      fail(`${entry.id}: prompt teaches the model implementation vocabulary`);
    }
    if (!Array.isArray(entry.requiredTools) || !Array.isArray(entry.forbiddenTools)) {
      fail(`${entry.id}: required/forbidden tool lists are missing`);
    }
    if (entry.requiredTools.some((name) => entry.forbiddenTools.includes(name))) {
      fail(`${entry.id}: a tool is both required and forbidden`);
    }
    if (typeof entry.expectedConsequence !== "string" || !entry.expectedConsequence) {
      fail(`${entry.id}: expected consequence is required`);
    }
  }
  return suite;
}

export function validateResults({ suite, evidence, suiteSha256 }) {
  if (evidence?.kind !== "opendexter-novice-routing-evaluation/v1") {
    fail("unexpected novice-routing evidence kind");
  }
  if (evidence?.status !== "passed") fail("novice-routing evidence is not passed");
  if (!/^[0-9a-f]{40}$/.test(evidence?.source?.commit ?? "")) fail("evidence source commit is missing");
  if (!/^[0-9a-f]{40}$/.test(evidence?.source?.tree ?? "")) fail("evidence source tree is missing");
  if (evidence?.suiteSha256 !== suiteSha256) fail("evidence used a different prompt suite");
  if (!Array.isArray(evidence.results) || evidence.results.length !== suite.cases.length) {
    fail("evidence does not cover every novice-language case exactly once");
  }
  const byId = new Map(evidence.results.map((result) => [result.caseId, result]));
  if (byId.size !== suite.cases.length) fail("evidence contains duplicate case results");
  for (const entry of suite.cases) {
    const result = byId.get(entry.id);
    if (!result) fail(`missing result for ${entry.id}`);
    if (result.outcome !== "passed") fail(`${entry.id}: outcome is not passed`);
    if (!Array.isArray(result.observedToolNames)) fail(`${entry.id}: observed tools are missing`);
    let cursor = -1;
    for (const name of entry.requiredTools) {
      const next = result.observedToolNames.indexOf(name, cursor + 1);
      if (next < 0) fail(`${entry.id}: required route omitted or reordered ${name}`);
      cursor = next;
    }
    for (const name of entry.forbiddenTools) {
      if (result.observedToolNames.includes(name)) fail(`${entry.id}: invoked forbidden ${name}`);
    }
    if (result.observedConsequence !== entry.expectedConsequence) {
      fail(`${entry.id}: consequence classification drifted`);
    }
    if (result.usedMagicPrompt === true || result.forcedToolSequence === true) {
      fail(`${entry.id}: result was produced with a coached or forced prompt`);
    }
  }
  return evidence;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const casesPath = realpathSync(args.cases ?? defaultCasesPath);
    const suite = validateCases(readJson(casesPath));
    if (args.results) {
      const evidence = readJson(realpathSync(args.results));
      validateResults({ suite, evidence, suiteSha256: digest(casesPath) });
      process.stdout.write(`Novice-language routing evidence passed ${suite.cases.length} cases.\n`);
    } else {
      process.stdout.write(
        `Validated ${suite.cases.length} ordinary-language routing cases; `
          + "no execution evidence was claimed.\n",
      );
    }
  } catch (error) {
    process.stderr.write(`OpenDexter novice-routing evaluation refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
