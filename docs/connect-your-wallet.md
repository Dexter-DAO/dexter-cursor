# Connect your Dexter wallet to your terminal

Your Dexter Wallet lives behind your passkey (Face ID or your fingerprint).
Connect lets the local OpenDexter proxy use the same hosted governed wallet for
account reads and bounded x402 execution—without copying a key or typing a
password.

The local process is only a proxy. It never changes payment over to a wallet
file or environment key. Payment authority is active only when the live status
projection proves the approved grant, limits, capacity, expiry, role, and
revocation state.

## Before you start

You need two things:

- **The OpenDexter tool.** One command installs it (below).
- **A Dexter wallet.** If you don't have one yet, set it up first at [dexter.cash/wallet](https://dexter.cash/wallet) — it takes one tap.

## Connect in 4 steps

### 1. Install OpenDexter

```
npm install -g @dexterai/opendexter@1.24.0-rc.2
```

That's a one-time thing. If you do not want a global install, run each command
with `npx @dexterai/opendexter@1.24.0-rc.2 …` instead. Both paths require
Node.js 22 or newer.

### 2. Run connect

```
opendexter connect
```

Your terminal shows three ways to approve — you only need **one** of them:

- a **link** you can click,
- a **QR code** you can scan with your phone,
- a short **code** you can type in.

### 3. Approve with your passkey

Pick whichever is easiest:

- **On the same computer:** click the link. Your browser opens the approval page.
- **On your phone:** scan the QR code with your camera.
- **On a server with no browser:** go to [dexter.cash/wallet/connect](https://dexter.cash/wallet/connect) on any device and type the short code.

The page shows you which app is asking, the authority requested, and its
limits. Tap **Face ID / your fingerprint** to approve. Back in your terminal,
you'll see:

```
Connected your Dexter Wallet to the hosted governed x402 runtime
```

### 4. Verify authority, then see your wallet

```
opendexter connect status
```

Do not treat the connection as payment-ready unless status reports active
bounded payment authority with the expected grant and remaining capacity.
Then read the connected wallet:

```
opendexter wallet
```

You'll see your hosted balance, deposit address, and runtime-authority evidence.

## Good to know

- **No private key is copied into the terminal.** Your passkey approves the connection; there is no password to type or secret key to paste.
- **The same governed wallet is the payment source.** Account-bound tools use the hosted session and its server-verified grant. There is no local signer fallback.
- **The OAuth request is narrow.** It asks for exact scope `vault`; Dexter's signed `dexter_surface` token claim is separate and is not requested as a scope.
- **Old wallet files are preserved, not selected.** `opendexter wallet --legacy-recovery` can parse an existing file for validated public addresses and balance reads, but it never derives, returns, exports, or enables its private-key fields as a signer.
- **You can end access at either side.** Revoke the connector at [dexter.cash/wallet](https://dexter.cash/wallet). `opendexter connect disconnect` removes this terminal's stored session but does not perform the server-side revocation.
- **It works anywhere** — your laptop, or a headless server over SSH. If there's no browser on the machine, the short-code path always works.
- **To fund your wallet,** send USDC on Solana to the deposit address `opendexter wallet` shows you. (Always use that address — it's the right one.)

## If something looks off

- **"Your wallet isn't set up yet"** — you have OpenDexter connected, but haven't finished creating your wallet. Open the setup link it gives you, then run `opendexter connect` again.
- **The code expired** — codes last 10 minutes. Just run `opendexter connect` again for a fresh one.
- **Want to disconnect?** Run `opendexter connect disconnect` to remove this terminal's session. Revoke the connector separately from your wallet page.
