import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DextercardApiError,
  DextercardNoAccountError,
  CardOnboardingFinishSchema,
  CardOnboardingStartSchema,
} from "@dexterai/dextercard";
import type { CardToolOpts } from "../../types.js";
import { maybeLoginRequiredResult } from "./_remote-failures.js";

/**
 * card_issue — stage-aware Dextercard issuance.
 *
 * The agent doesn't have to know which step the user is on. It calls
 * card_issue with whatever inputs it has; this tool inspects current
 * state and either:
 *   - kicks off onboarding (if start data provided + nothing yet),
 *   - polls KYC status (if mid-flight),
 *   - finalizes (if verified + finalize data provided),
 *   - issues the card (if onboarding done),
 *   - reveals card details (if explicitly requested).
 *
 * Every call returns { nextAction } telling the agent what to do
 * next — fetch a KYC URL the user needs to visit, gather an address,
 * call card_status, etc.
 */
export function registerCardIssueTool(server: McpServer, opts: CardToolOpts): void {
  const meta = opts.metas.issue;
  const cards = opts.cards;
  const noSessionTip =
    opts.noSessionTip ??
    "No Dextercard session. Sign in before issuing a card.";

  // Inputs are a discriminated union by `step`. The wizard calls this
  // tool repeatedly with whatever step the agent is ready to run.
  const startInput = CardOnboardingStartSchema.shape;
  const finishInput = CardOnboardingFinishSchema.shape;

  server.tool(
    "card_issue",
    "Drive Dextercard issuance one step at a time. The tool inspects current onboarding state and runs the correct next action: " +
      "(`auto`) figure out the next step automatically — recommended; " +
      "(`start`) submit identity for KYC; " +
      "(`check`) poll KYC status (returns terms URLs once verified); " +
      "(`finish`) finalize with address + accepted terms; " +
      "(`create`) issue the virtual Mastercard; " +
      "(`reveal`) get a single-use PCI-safe URL with PAN/CVV/expiry. " +
      "Always returns a `nextAction` field describing what the agent should do next.",
    {
      step: z
        .enum(["auto", "start", "check", "finish", "create", "reveal"])
        .default("auto")
        .describe("Which step of the issuance pipeline to run. Default: auto."),
      // Inputs for `start` (only required when step === "start" or auto with no card account)
      phoneCountryCode: startInput.phoneCountryCode.optional(),
      phoneNumber: startInput.phoneNumber.optional(),
      countryOfResidence: startInput.countryOfResidence.optional(),
      firstName: startInput.firstName.optional(),
      lastName: startInput.lastName.optional(),
      dateOfBirth: startInput.dateOfBirth.optional(),
      countryOfNationality: startInput.countryOfNationality.optional(),
      // Inputs for `finish`
      addressLine1: finishInput.addressLine1.optional(),
      addressLine2: finishInput.addressLine2.optional(),
      city: finishInput.city.optional(),
      zip: finishInput.zip.optional(),
      acceptTerms: finishInput.acceptTerms.optional(),
      acceptESign: finishInput.acceptESign.optional(),
    },
    async (args) => {
      if (!cards) return wrap({ stage: "no_session", tip: noSessionTip, nextAction: "configure_session" }, meta);
      const client = await cards.getOperations();
      if (!client) return wrap({ stage: "no_session", tip: noSessionTip, nextAction: "configure_session" }, meta);

      try {
        const step = args.step ?? "auto";

        if (step === "reveal") {
          const reveal = await client.cardReveal();
          return wrap({
            stage: "active",
            reveal,
            nextAction: "show_reveal_url",
          }, meta);
        }

        if (step === "create") {
          const card = await client.cardCreate();
          return wrap({
            stage: "active",
            card,
            nextAction: "call_card_status",
          }, meta);
        }

        if (step === "start") {
          const startArgs = requireStartArgs(args);
          const result = await client.cardOnboardingStart(startArgs);
          return wrap({
            stage: "pending_kyc",
            onboardingStart: result,
            nextAction: result.kycUrl ? "send_user_to_kyc_url" : "call_card_issue_check",
          }, meta);
        }

        if (step === "check") {
          const result = await client.cardOnboardingCheck();
          const status = String((result as { status?: string }).status ?? "").toLowerCase();
          return wrap({
            stage: status === "verified" ? "pending_finalize" : "pending_kyc",
            onboardingCheck: result,
            nextAction:
              status === "verified" ? "call_card_issue_finish" : "wait_and_call_card_issue_check",
          }, meta);
        }

        if (step === "finish") {
          const finishArgs = requireFinishArgs(args);
          const result = await client.cardOnboardingFinish(finishArgs);
          return wrap({
            stage: "not_issued",
            onboardingFinish: result,
            nextAction: "call_card_issue_create",
          }, meta);
        }

        // step === "auto": inspect current state and run the right thing
        const detected = await detectStage(client);
        if (detected === "onboarding_required") {
          // Need start args. If absent, ask for them.
          if (!hasAllStartArgs(args)) {
            return wrap({
              stage: "onboarding_required",
              nextAction: "collect_identity_then_call_card_issue_with_step_start",
              required: [
                "phoneCountryCode", "phoneNumber", "countryOfResidence",
                "firstName", "lastName", "dateOfBirth", "countryOfNationality",
              ],
            }, meta);
          }
          const result = await client.cardOnboardingStart(requireStartArgs(args));
          return wrap({
            stage: "pending_kyc",
            onboardingStart: result,
            nextAction: result.kycUrl ? "send_user_to_kyc_url" : "call_card_issue_check",
          }, meta);
        }

        if (detected === "pending_kyc") {
          const result = await client.cardOnboardingCheck();
          const status = String((result as { status?: string }).status ?? "").toLowerCase();
          return wrap({
            stage: status === "verified" ? "pending_finalize" : "pending_kyc",
            onboardingCheck: result,
            nextAction:
              status === "verified"
                ? "call_card_issue_finish"
                : "wait_and_call_card_issue_check",
          }, meta);
        }

        if (detected === "pending_finalize") {
          // detectStage maps a 'verified' onboarding check to
          // pending_finalize, but that covers two real sub-states:
          // (a) verified, not finalized; (b) verified, finalized, no card
          // yet. cardCreate is the deterministic probe — it succeeds only
          // when onboarding is fully finalized. Try it before asking for
          // an address the user may have already submitted.
          try {
            const card = await client.cardCreate();
            return wrap({
              stage: "active",
              card,
              nextAction: "call_card_status",
            }, meta);
          } catch (createErr) {
            // A carrier error here means onboarding is not finalized.
            // Fall through to the finalize step.
            if (
              !(createErr instanceof DextercardApiError) &&
              !(createErr instanceof DextercardNoAccountError)
            ) {
              throw createErr;
            }
          }
          if (!hasAllFinishArgs(args)) {
            return wrap({
              stage: "pending_finalize",
              nextAction: "collect_address_then_call_card_issue_with_step_finish",
              required: ["addressLine1", "city", "zip", "acceptTerms"],
            }, meta);
          }
          const result = await client.cardOnboardingFinish(requireFinishArgs(args));
          return wrap({
            stage: "not_issued",
            onboardingFinish: result,
            nextAction: "call_card_issue_create",
          }, meta);
        }

        if (detected === "not_issued") {
          const card = await client.cardCreate();
          return wrap({
            stage: "active",
            card,
            nextAction: "call_card_status",
          }, meta);
        }

        // Already active or frozen — nothing to do.
        const existing = await client.cardRetrieve();
        return wrap({
          stage: detected,
          card: existing,
          nextAction: "call_card_status",
        }, meta);
      } catch (err: any) {
        const loginRequired = maybeLoginRequiredResult(err, meta);
        if (loginRequired) return loginRequired;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  ).update({ _meta: meta });
}

type DetectedStage =
  | "onboarding_required"
  | "pending_kyc"
  | "pending_finalize"
  | "not_issued"
  | "active"
  | "frozen";

async function detectStage(client: import("../../card-operations.js").CardOperations): Promise<DetectedStage> {
  try {
    const card = await client.cardRetrieve();
    const status = String((card as { status?: string }).status ?? "").toLowerCase();
    return status === "frozen" ? "frozen" : "active";
  } catch (err) {
    if (!(err instanceof DextercardNoAccountError)) throw err;
  }
  // No card yet — walk the onboarding ladder.
  try {
    const ob = await client.cardOnboardingCheck();
    const status = String((ob as { status?: string }).status ?? "").toLowerCase();
    if (status === "verified") return "pending_finalize";
    if (status) return "pending_kyc";
    return "onboarding_required";
  } catch (err) {
    if (err instanceof DextercardNoAccountError) return "onboarding_required";
    throw err;
  }
}

function hasAllStartArgs(args: Record<string, unknown>): boolean {
  return (
    typeof args.phoneCountryCode === "string" &&
    typeof args.phoneNumber === "string" &&
    typeof args.countryOfResidence === "string" &&
    typeof args.firstName === "string" &&
    typeof args.lastName === "string" &&
    typeof args.dateOfBirth === "string" &&
    typeof args.countryOfNationality === "string"
  );
}

function requireStartArgs(args: Record<string, unknown>) {
  if (!hasAllStartArgs(args)) {
    throw new Error(
      "card_issue start: missing required identity fields (phoneCountryCode, phoneNumber, countryOfResidence, firstName, lastName, dateOfBirth, countryOfNationality)",
    );
  }
  return {
    phoneCountryCode: args.phoneCountryCode as string,
    phoneNumber: args.phoneNumber as string,
    countryOfResidence: args.countryOfResidence as string,
    firstName: args.firstName as string,
    lastName: args.lastName as string,
    dateOfBirth: args.dateOfBirth as string,
    countryOfNationality: args.countryOfNationality as string,
  };
}

function hasAllFinishArgs(args: Record<string, unknown>): boolean {
  return (
    typeof args.addressLine1 === "string" &&
    typeof args.city === "string" &&
    typeof args.zip === "string" &&
    args.acceptTerms === true
  );
}

function requireFinishArgs(args: Record<string, unknown>) {
  if (!hasAllFinishArgs(args)) {
    throw new Error(
      "card_issue finish: missing required address fields (addressLine1, city, zip) or acceptTerms not set to true",
    );
  }
  return {
    addressLine1: args.addressLine1 as string,
    addressLine2: typeof args.addressLine2 === "string" ? args.addressLine2 : undefined,
    city: args.city as string,
    zip: args.zip as string,
    acceptTerms: true as const,
    acceptESign: typeof args.acceptESign === "boolean" ? args.acceptESign : undefined,
  };
}

function wrap(data: Record<string, unknown>, meta: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    _meta: meta,
  } as any;
}
