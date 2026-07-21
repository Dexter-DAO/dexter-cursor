import { describe, it, expect } from 'vitest';
import {
  buildServerInstructions, LOCAL_CAPS, HOSTED_CAPS,
  SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_VERSION,
  assertInstructionRosterParity,
} from './index.js';
import pkg from '../package.json';

const local = buildServerInstructions(LOCAL_CAPS);
const hosted = buildServerInstructions(HOSTED_CAPS);

describe('hosted rendering (HOSTED_CAPS)', () => {
  it('never mentions tools the hosted roster lacks', () => {
    expect(hosted).not.toContain('x402_settings');
    expect(hosted).not.toContain('card_login_start');
    expect(hosted).not.toContain('maxAmountUsdc');
  });
  it('uses the dexter.cash card fallback instead of card_login_start', () => {
    expect(hosted).toContain('https://dexter.cash/dextercard');
  });
  it('is Solana-only on funding and forbids EVM deposit advice', () => {
    expect(hosted).toContain('USDC on Solana only');
    expect(hosted).not.toContain('Funding chains: Solana, Base');
  });
  it('documents the passkey onboarding tools', () => {
    expect(hosted).toContain('dexter_passkey');
  });
  it('routes walletless users to dexter_passkey, not env vars', () => {
    expect(hosted).not.toContain('DEXTER_PRIVATE_KEY');
  });
  it('contains no hardcoded cap dollar amounts', () => {
    expect(hosted).not.toMatch(/\$\s?(10|50|100) (USDC|per)/);
  });
});

describe('local rendering (LOCAL_CAPS)', () => {
  it('keeps settings routing and the policy-block recipe', () => {
    expect(local).toContain('x402_settings');
    expect(local).toContain('maxAmountUsdc');
  });
  it('keeps card_login_start fallback and env-var wallet recipe', () => {
    expect(local).toContain('card_login_start');
    expect(local).toContain('DEXTER_PRIVATE_KEY');
  });
  it('never mentions hosted-only tools', () => {
    expect(local).not.toContain('dexter_passkey');
  });
  it('SERVER_INSTRUCTIONS alias equals the local rendering', () => {
    expect(SERVER_INSTRUCTIONS).toBe(local);
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
  it('both shipped renderings are self-consistent with their caps rosters', () => {
    const hostedRoster = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','x402_compose_skill','promote_skill','card_status','card_issue','card_link_wallet','card_freeze','card_login_request_otp','card_login_complete','dexter_passkey_probe','dexter_passkey'];
    const localRoster  = ['x402_search','x402_pay','x402_fetch','x402_check','x402_access','x402_wallet','x402_settings','card_status','card_issue','card_link_wallet','card_freeze','card_login_request_otp','card_login_complete','card_login_start'];
    expect(() => assertInstructionRosterParity(hosted, hostedRoster)).not.toThrow();
    expect(() => assertInstructionRosterParity(local, localRoster)).not.toThrow();
  });
});
