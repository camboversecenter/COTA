# Wallet signer (vendored from zk-vault-react)

This folder is the `src/wallet` module of
[`sengtha/zk-vault-react`](https://github.com/sengtha/zk-vault-react) (MIT, see
`LICENSE-zk-vault-react`), copied unchanged. The private key is generated and used
only inside `signer.worker.ts`; the page asks the worker to sign EIP-712 digests
and never sees the key. Envelopes are stored in Cloudflare D1 by
`src/client/vaultStorage.ts`.

To update: copy `src/wallet/*.ts` from the upstream repository again.
