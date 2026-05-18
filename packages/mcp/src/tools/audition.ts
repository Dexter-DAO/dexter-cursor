import { getApiBase } from "../config.js";

/**
 * CLI entrypoint for the `opendexter audition` subcommand.
 *
 * Merchant-onboarding, agent-first. A merchant's coding agent runs this with a
 * bare server URL; OpenDexter discovers the paid routes, runs a REAL paid test
 * against each, scores the live response, and synthesizes an agent-callable
 * Skill. The agent reads the result, fixes the merchant's OpenAPI, and
 * re-auditions until it scores well.
 *
 * This is the answer to AgentCash's `@agentcash/discovery` — theirs validates
 * that an OpenAPI document is well-formed; ours proves the API actually works
 * by paying it, and hands back the Skill an agent will call it with.
 *
 * --json   machine-readable output (the default-designed path — an agent
 *          parses this). Omit it for a human-readable summary.
 *
 * Auditioning a high-scoring API lists it in the catalog automatically (the
 * verifier auto-approves on a passing score) — that is the desired outcome,
 * not a side effect.
 */
export async function cliAudition(
  url: string,
  opts: { json: boolean; dev: boolean },
): Promise<void> {
  const apiBase = getApiBase(opts.dev).replace(/\/+$/, "");
  try {
    const res = await fetch(`${apiBase}/api/public/discoverable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok || data?.ok === false) {
      const payload = { error: data?.error ?? "audition_failed", message: data?.message ?? `HTTP ${res.status}` };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.error(`Audition failed: ${payload.message}`);
      }
      process.exit(1);
    }

    if (opts.json) {
      // Agent path — the full structured result.
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Human-readable fallback.
    const s = data.summary ?? {};
    console.log(`\nAudition — ${data.origin ?? url}`);
    console.log(`  ${s.registered ?? 0}/${s.total ?? 0} paid routes tested` +
      (s.avgScore != null ? `  ·  average score ${s.avgScore}/100` : ""));
    for (const r of data.routes ?? []) {
      const tag = r.score != null ? `[${r.score}]` : "[—]";
      console.log(`\n  ${tag} ${r.url}`);
      // Score history — show the re-audition delta when there's a prior run.
      if (typeof r.previousScore === "number" && typeof r.delta === "number") {
        const sign = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
        const arrow = r.delta > 0 ? "▲" : r.delta < 0 ? "▼" : "■";
        console.log(`      ${arrow} ${r.previousScore} → ${r.score} (${sign} since last audition)`);
      }
      if (r.verdict) console.log(`      ${r.verdict}`);
      if (r.fixInstructions) console.log(`      fix: ${r.fixInstructions}`);
      if (r.synthesizedSkill) console.log(`      ✓ agent-callable Skill synthesized`);
    }
    console.log("");
  } catch (err: any) {
    const payload = { error: "audition_failed", message: err?.message ?? String(err) };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else console.error(`Audition failed: ${payload.message}`);
    process.exit(1);
  }
}
