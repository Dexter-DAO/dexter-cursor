# Connect your Dexter wallet to your terminal

Your Dexter wallet lives behind your passkey (Face ID or your fingerprint). In
under a minute you can let the local OpenDexter package show its balance and
Solana deposit address — without copying a key or typing a password.

The local package currently uses this connector session only for wallet reads.
It does not change the payment signer: local paid calls still use the wallet in
`~/.dexterai-mcp/wallet.json`, or the Solana/EVM keys configured through
environment variables.

## Before you start

You need two things:

- **The OpenDexter tool.** One command installs it (below).
- **A Dexter wallet.** If you don't have one yet, set it up first at [dexter.cash/wallet](https://dexter.cash/wallet) — it takes one tap.

## Connect in 4 steps

### 1. Install OpenDexter

```
npm install -g @dexterai/opendexter@1.23.0-rc.3
```

That's a one-time thing. If you do not want a global install, run each command
with `npx @dexterai/opendexter@1.23.0-rc.3 …` instead. Both paths require
Node.js.

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

The page shows you which app is asking to connect. Tap **Face ID / your fingerprint** to approve. Back in your terminal, you'll see:

```
Connected to your Dexter wallet
```

### 4. See your wallet

```
opendexter wallet
```

You'll see your balance and your deposit address. Done.

## Good to know

- **No private key is copied into the terminal.** Your passkey approves the connection; there is no password to type or secret key to paste.
- **The local package uses the session for wallet reads.** It does not change the payment signer. Local paid calls still use the local wallet.
- **You can end access at either side.** Revoke the connector at [dexter.cash/wallet](https://dexter.cash/wallet). `opendexter connect disconnect` removes this terminal's stored session but does not perform the server-side revocation.
- **It works anywhere** — your laptop, or a headless server over SSH. If there's no browser on the machine, the short-code path always works.
- **To fund your wallet,** send USDC on Solana to the deposit address `opendexter wallet` shows you. (Always use that address — it's the right one.)

## If something looks off

- **"Your wallet isn't set up yet"** — you have OpenDexter connected, but haven't finished creating your wallet. Open the setup link it gives you, then run `opendexter connect` again.
- **The code expired** — codes last 10 minutes. Just run `opendexter connect` again for a fresh one.
- **Want to disconnect?** Run `opendexter connect disconnect` to remove this terminal's session. Revoke the connector separately from your wallet page.
