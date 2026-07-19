# Connect your Dexter wallet to your terminal

Your Dexter wallet lives on your phone and laptop, locked behind your passkey (Face ID or your fingerprint). In under a minute you can connect it to your terminal, so your AI agent can see your wallet and pay for things — without ever copying a key or typing a password.

## Before you start

You need two things:

- **The OpenDexter tool.** One command installs it (below).
- **A Dexter wallet.** If you don't have one yet, set it up first at [dexter.cash/wallet](https://dexter.cash/wallet) — it takes one tap.

## Connect in 4 steps

### 1. Install OpenDexter

```
npm install -g @dexterai/opendexter
```

That's a one-time thing. (No Node? You can also just run each command with `npx @dexterai/opendexter …` instead.)

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

- **Nothing leaves your device but a signature.** Your passkey is the only thing that approves the connection. There's no password, and your keys never move.
- **You're always in control.** Revoke the connection anytime at [dexter.cash/wallet](https://dexter.cash/wallet).
- **It works anywhere** — your laptop, or a headless server over SSH. If there's no browser on the machine, the short-code path always works.
- **To fund your wallet,** send USDC on Solana to the deposit address `opendexter wallet` shows you. (Always use that address — it's the right one.)

## If something looks off

- **"Your wallet isn't set up yet"** — you have OpenDexter connected, but haven't finished creating your wallet. Open the setup link it gives you, then run `opendexter connect` again.
- **The code expired** — codes last 10 minutes. Just run `opendexter connect` again for a fresh one.
- **Want to disconnect?** Run `opendexter connect disconnect`, or revoke it from your wallet page.
