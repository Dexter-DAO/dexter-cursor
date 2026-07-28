import { describe, it, expect } from 'vitest';
import {
  buildServerInstructions, LOCAL_CAPS, HOSTED_CAPS,
  SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_VERSION,
  assertInstructionRosterParity,
} from './index.js';
import pkg from '../package.json';

const local = buildServerInstructions(LOCAL_CAPS);
const hosted = buildServerInstructions(HOSTED_CAPS);
// Pre-ruling caps: what a consumer still pinned to card-era behavior renders.
const cardsOnLocal = buildServerInstructions({ ...LOCAL_CAPS, hasCardTools: true, hasCardLoginStart: true });

describe('hosted rendering (HOSTED_CAPS)', () => {
  it('never mentions tools the hosted roster lacks', () => {
    expect(hosted).not.toContain('x402_settings');
    expect(hosted).not.toContain('card_login_start');
    expect(hosted).not.toContain('maxAmountUsdc');
  });
  it('is Solana-only on funding and forbids EVM deposit advice', () => {
    expect(hosted).toContain('USDC on Solana only');
    expect(hosted).not.toContain('Funding chains: Solana, Base');
  });
  it('documents the passkey onboarding tools', () => {
    expect(hosted).toContain('dexter_passkey');
  });
  it('documents the session-bound portfolio tool without caller authority', () => {
    expect(hosted).toContain('dexter_portfolio');
    expect(hosted).toContain('accepts no caller-supplied handle');
    expect(hosted).toContain('portfolio value separate from spendable cash');
  });
  it('routes walletless users to dexter_passkey, not env vars', () => {
    expect(hosted).not.toContain('DEXTER_PRIVATE_KEY');
  });
  it('uses native OAuth wording and separates account authorization from wallet readiness', () => {
    expect(hosted).toContain("native OpenDexter Connect action");
    expect(hosted).toContain("does not by itself prove that a ready passkey wallet is bound");
    expect(hosted).not.toMatch(/\b(?:setup|enroll) link\b|\brelay(?:ing|ed|s)?\b/i);
  });
  it('contains no hardcoded cap dollar amounts', () => {
    expect(hosted).not.toMatch(/\$\s?(10|50|100) (USDC|per)/);
  });
});

describe('cards-off (owner ruling Jul 23 — both first-party surfaces)', () => {
  it('names zero card tools on either surface', () => {
    for (const rendering of [hosted, local]) {
      expect(rendering).not.toMatch(/card_(status|issue|link_wallet|freeze|login_request_otp|login_complete|login_start)/);
    }
  });
  it('drops the Dextercard preamble claim and the provisioning section', () => {
    for (const rendering of [hosted, local]) {
      expect(rendering).not.toContain('for provisioning a Dextercard');
      expect(rendering).not.toContain('Provisioning a new Dextercard');
      expect(rendering).not.toContain('Do not guess personal data');
    }
  });
  it('routes card intent to the wallet + web page instead', () => {
    for (const rendering of [hosted, local]) {
      expect(rendering).toContain('the card lives in the wallet');
      expect(rendering).toContain('https://dexter.cash/dextercard');
    }
  });
});

describe('cards-on backward compat (hasCardTools defaulted/true)', () => {
  it('default (flag absent) keeps the card sections — existing consumers unchanged', () => {
    const { hasCardTools: _drop, ...legacyShape } = LOCAL_CAPS;
    const legacy = buildServerInstructions({ ...legacyShape, hasCardLoginStart: true });
    expect(legacy).toContain('card_status');
    expect(legacy).toContain('Provisioning a new Dextercard');
  });
  it('explicit true renders the full card machine + local fallback', () => {
    expect(cardsOnLocal).toContain('card_status');
    expect(cardsOnLocal).toContain('card_login_start');
    expect(cardsOnLocal).toContain('Do not guess personal data');
  });
});

describe('local rendering (LOCAL_CAPS)', () => {
  it('keeps settings routing and the policy-block recipe', () => {
    expect(local).toContain('x402_settings');
    expect(local).toContain('maxAmountUsdc');
  });
  it('keeps the env-var wallet recipe', () => {
    expect(local).toContain('DEXTER_PRIVATE_KEY');
  });
  it('describes the actual local wallet instead of a hosted-style session', () => {
    expect(local).toContain('local file-backed or environment-configured Solana/EVM wallet');
    expect(local).not.toContain('Creates or resumes a multi-chain session');
  });
  it('adds the connected portfolio while keeping passkey setup hosted-only', () => {
    expect(local).not.toContain('dexter_passkey');
    expect(local).toContain('dexter_portfolio');
    expect(local).toContain('keep portfolio value separate from spendable cash');
  });
  it('SERVER_INSTRUCTIONS alias equals the local rendering', () => {
    expect(SERVER_INSTRUCTIONS).toBe(local);
  });
});

describe('prepared purchase guidance', () => {
  it.each([
    ['hosted', hosted],
    ['local', local],
  ])('%s preserves one selected mode and forbids post-dispatch retry', (_name, rendering) => {
    for (const mode of [
      'direct_exact',
      'native_tab',
      'gateway_cash',
      'gateway_credit',
    ]) {
      expect(rendering).toContain(mode);
    }
    expect(rendering).toContain('purchaseOptions');
    expect(rendering).toContain('availability.state is ready');
    expect(rendering).toContain('preparedPurchase');
    expect(rendering).toContain('Do not reconstruct');
    expect(rendering).toContain('Never retry automatically');
    expect(rendering).toContain('purchaseReceipt');
  });
});

describe('version stamp', () => {
  it('tracks package.json exactly', () => {
    expect(SERVER_INSTRUCTIONS_VERSION).toBe(pkg.version);
  });
});

describe('assertInstructionRosterParity', () => {
  it('passes when every mentioned tool is registered', () => {
    expect(() => assertInstructionRosterParity(
      'use x402_search then x402_fetch', ['x402_search', 'x402_fetch', 'extra_tool'],
    )).not.toThrow();
  });
  it('throws naming each missing tool', () => {
    expect(() => assertInstructionRosterParity(
      'call x402_settings or card_login_start', ['x402_search'],
    )).toThrow(/x402_settings.*card_login_start|card_login_start.*x402_settings/);
  });
  it('both shipped renderings are self-consistent with their card-free rosters', () => {
    const hostedRoster = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','dexter_portfolio','x402_compose_skill','promote_skill','dexter_passkey_probe','dexter_passkey'];
    const localRoster  = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','dexter_portfolio','x402_settings'];
    expect(() => assertInstructionRosterParity(hosted, hostedRoster)).not.toThrow();
    expect(() => assertInstructionRosterParity(local, localRoster)).not.toThrow();
  });
});
