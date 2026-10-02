# Nokor Pass — Specification

*Version 0.1 · draft · CamboVerse Center, National University of Management*

This document specifies Nokor Pass: one pass for everyone in Cambodia that identifies the holder, pays, opens heritage sites, and refunds visitors at departure, plus Nokor Point, a giftable point. It is the reference for the contracts in [`contracts/`](../contracts) and the reference implementation in [`app/`](../app). Where this document and the code disagree, that is a bug in one of them.

Section numbers are cited from the contracts (`SPEC §n`) and from the paper *Nokor Pass: Repeat Visits, Not Promotion* (Chay, Khut and Va, 2026).

The keywords MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

---

## 1. Goals and non-goals

**Goals**

1. Every payment a holder makes is protected by design against overlay codes, phishing codes and currency substitution: the payer never scans a code, sees the amount and currency before approving, and can dispute within a window.
2. A merchant's proceeds are a claim, not cash, until a hold has passed; exit controls bind from the first payment.
3. One pass opens every participating site.
4. Repeat visits and word of mouth become measurable without identifying anyone.
5. The holder never sees a seed phrase, a gas fee, or a blockchain.

**Non-goals**

- Nokor Pass does not address the causes of Cambodia's reputation damage, off-rail problems (litter, touts, roads), or sites with no gate and no merchant (paper §8).
- The prototype does not implement the institutional separation of roles (§11); one operator key holds them all.

## 2. Actors

| Actor | Role | On-chain role |
| --- | --- | --- |
| Holder | A visitor or resident with a pass | — |
| Immigration (GDI) | Issues visitor passes at arrival; closes them at departure | `NokorPass.ISSUER_ROLE` |
| Ministry of Interior | Issues resident passes | `NokorPass.ISSUER_ROLE` |
| National Bank of Cambodia | Issues kRIEL and kUSD, fully reserved | `NokorMoney.MINTER_ROLE`, `DEFAULT_ADMIN_ROLE` |
| Operator | Runs escrow decisions, merchant registry, relaying, paymaster | `NokorMoney.OPERATOR_ROLE`, `NokorRegistry.MERCHANT_ADMIN_ROLE`, `NokorPoint.REDEEMER_ROLE` |
| Ministry of Tourism | Nokor Point policy; reference fares | `NokorPoint.MINTER_ROLE` |
| Site authority | Publishes access products; runs gates | `NokorAccess.SITE_ADMIN_ROLE`, `GATE_ROLE` |
| Merchant | Receives payments; cashes out | registered in `NokorRegistry` |

## 3. The pass (`NokorPass`)

3.1 A pass is an ERC-721 token that MUST NOT be transferable or approvable (soulbound).

3.2 A pass records: category (`Visitor` or `Resident`), issuer, issue time, validity end (0 = none), close time, revoked flag, `docHash`, and `previousPassId`.

3.3 **No personal data on chain.** `docHash` MUST be `HMAC-SHA256(issuerSecret, normalise(documentNumber))`, computed off-chain by the issuer. A plain hash MUST NOT be used: document numbers are short enough to enumerate. `issuerSecret` MUST NOT be published.

3.4 A holder MAY hold several passes over time but at most one valid pass. Issuing a pass for a `docHash` whose latest pass is still open MUST close that earlier pass.

3.5 `previousPassId` links passes issued against the same `docHash`. `samePerson(a, b)` returns whether two passes share a `docHash`. This is how a returning visitor is recognised without being identified.

3.6 A visitor receives a new pass on each arrival; the pass is the record of that trip. At departure immigration MUST close it.

3.7 A pass is valid when it exists, is not revoked, is not closed, and is within its validity.

## 4. Money (`NokorMoney`: kRIEL, kUSD)

4.1 One deployment per currency. kRIEL has 0 decimals; kUSD has 2.

4.2 **Reserves.** Every unit MUST be backed one for one by riel or dollars held by the issuer. `mint` is called only after the operator has received the funds (card, bank transfer, cash). The top-up reference MUST be recorded in the `Minted` event.

4.3 **Closed loop.** Transfers are restricted:

| Movement | Allowed when |
| --- | --- |
| Mint | Recipient holds a valid pass |
| Into escrow | Only through `pay` / `payWithSig` |
| Escrow → merchant | Release or resolution in the merchant's favour; merchant is active |
| Escrow → payer | Refund; payer's pass need not still be valid |
| Holder → holder | Both hold valid passes |
| Merchant → anyone | Never, even if the merchant address also holds a pass; a merchant's only exit is `cashOut` |
| Burn | By the owner: `cashOut` for merchants (daily cap), `redeem` for everyone else |
| Any | Neither party is frozen |

4.4 **Signed intents.** Every holder and merchant action has an EIP-712 variant (`payWithSig`, `disputeWithSig`, `redeemWithSig`, `cashOutWithSig`) so that the operator submits it and pays the gas. Each carries a per-holder nonce and a deadline.

## 5. Payments, escrow and exits

5.1 **The payee starts every payment.** A merchant's registered device creates a request off-chain (§9). The payer's wallet MUST display, before approval: the merchant's registered name, the amount, the currency by ISO 4217 code (`KHR`, `USD`), and for visitors the amount in their home currency. The payer approves with the passkey or PIN; the wallet signs `Pay(payer, merchant, amount, ref, nonce, deadline)`. The payer MUST NOT be asked to scan a code.

5.2 `ref` is the request identifier. A `ref` MUST NOT be used for two payments.

5.3 **Escrow.** An approved payment moves to the contract with `releaseAt = now + disputeWindow + holdSeconds[riskClass]`.

5.4 **Disputes.** Within `disputeWindow` of payment, the payer MAY dispute. A disputed payment does not release on its own; the operator resolves it, refunding the payer or paying the merchant.

5.5 **Clawback.** The operator MAY resolve an undisputed payment that is still in escrow (fraud). Funds already released cannot be moved.

5.6 **Release.** After `releaseAt`, anyone MAY release an escrowed payment to the merchant.

5.7 **Risk classes and exit controls.** Each merchant has a risk class: `Established`, `Standard`, `New`. Each class has an extra hold and a daily cash-out cap. New merchants wait longest and cash out least.

5.8 **Cash-out.** A merchant burns released balance with `cashOut(amount, bankRef)` or, signed on its device, `cashOutWithSig`; the operator settles `bankRef` to the merchant's bank account, using Bakong as the settlement rail.

5.9 **Reference fares.** For regulated categories (tuk-tuk, boat) the operator publishes reference fares; a request above the reference for its route MUST be flagged to the payer before approval. (Off-chain, §9.)

5.10 **Departure.** A visitor converts remaining balance back to card or cash with `redeem` / `redeemWithSig`; the operator pays `payoutRef`. Then immigration closes the pass.

## 6. Site access (`NokorAccess`)

6.1 A site authority creates products: name, payee (its merchant account), price in kUSD and kRIEL, validity, number of entries (or unlimited), and the sites covered.

6.2 **Purchase** is an ordinary escrowed payment to the payee. `claim(productId, currency, paymentRef)` grants the entitlement after checking on chain that the payment exists, is escrowed or released, went to the product's payee, and was at least the price. One payment grants once. Only the payer, or the site admin relaying for the payer, MAY call `claim`, so nobody else can spend a payment on a different product first.

6.3 **Entry.** The gate's device starts the check: it creates an entry request off-chain; the holder confirms on the phone, signing `Enter(holder, productId, siteId, gateRef, nonce, deadline)`; a gate (`GATE_ROLE`) submits `enterWithSig`. The contract checks the pass, the site, the expiry and remaining entries, and emits `Visit`.

6.4 A site authority MAY revoke an entitlement whose payment was refunded.

## 7. Nokor Point (`NokorPoint`)

7.1 Points have no guaranteed cash value and MUST NOT be convertible into kRIEL or kUSD.

7.2 **Earning.** The Ministry of Tourism sets the policy (points per payment, per site entry); the minter awards points to the holder's current pass. The token id (ERC-1155) of a point is the **pass on which it was earned**.

7.3 **Moving.** Points move between holders of valid passes, into gift escrow, or out of gift escrow to a holder of a valid pass. Points expire `lifetime` after the issue of the pass they were earned on.

7.4 **Gifts.** A giver (who need not hold a valid pass) creates a gift into escrow with the address of a one-time claim key. The claim key travels to the friend in a link. To claim, the friend's app signs `Claim(giftId, recipient)` with the claim key; the recipient MUST hold a valid pass. A claim intercepted in transit cannot be redirected, because the signature binds the recipient. The giver MAY cancel an unclaimed gift.

7.5 **Redemption.** A holder signs `RedeemPoints(holder, earnedOnPass, amount, offerRef, nonce, deadline)`; the operator submits it. The event records the redeemer's pass and the earning pass, and two flags:

- `returning`: the same person, on a later pass (a return visit);
- `spread`: a different person (word of mouth).

7.6 **Baseline use.** The state SHOULD guarantee at least one use (for example a discount on site access) so points carry value before merchants join.

## 8. The wallet

8.1 The wallet is the `src/wallet` signer of [`zk-vault-react`](https://github.com/sengtha/zk-vault-react): a secp256k1 key generated and used only inside a Web Worker, encrypted by a random DEK, which is wrapped by an Argon2id PIN envelope and, where supported, a WebAuthn-PRF passkey envelope.

8.2 The server stores only ciphertext and public identifiers: PIN salt, PIN envelope, passkey envelope, passkey credential id, wallet envelope, Argon2id parameters, and the wallet address. Argon2id parameters MUST be stored with the record.

8.3 The page never receives the private key. It builds the EIP-712 digest and asks the worker to sign it.

8.4 Losing the PIN and every passkey loses the wallet. A visitor's balance is small and short-lived; a resident's recovery path is out of scope for this version.

## 9. Off-chain protocol (reference Worker)

9.1 **Pay code.** To be paid or admitted, the holder shows a six-character code that is valid for two minutes and bound to the holder's address. The merchant or gate types it (or reads it from the holder's screen). The code identifies the payer; it carries no amount and authorises nothing.

9.2 **Request.** The merchant's device creates a request `{ref, merchant, amount, currency, description, referenceFare?}`. The holder's wallet receives it, displays §5.1, and on approval returns the signature. The Worker submits `payWithSig`.

9.3 **Authentication.** Holders authenticate by signing a challenge with their wallet (EIP-191). Merchants, gates, issuers and the operator authenticate with API keys stored hashed.

9.4 **Relaying and fees.** The Worker holds the operator key and submits every signed intent; holders never pay gas.

9.5 **Indexing.** The Worker records every relayed event in D1 for dashboards. The chain is the source of truth; D1 can be rebuilt from events.

## 10. Indicators

| Indicator | Source |
| --- | --- |
| Repeat-visitor rate | `PassIssued` with non-zero `previousPassId`, as a share of visitor passes issued |
| Return value rate | `PointsRedeemed` with `returning = true`, as a share of points redeemed |
| Spread rate | `PointsRedeemed` with `spread = true`, as a share of points redeemed |
| Reach beyond Angkor | `Visit` events outside the Angkor sites, as a share of all visits |
| Dispute rate | `PaymentDisputed` per thousand `PaymentEscrowed`, by merchant category and province |
| Spending by place | `PaymentEscrowed` by merchant province and category |

## 11. Deployment and roles

11.1 Contracts target Base (Ethereum layer 2). The prototype targets Base Sepolia.

11.2 **Prototype simplification.** One operator key holds every operational role. In production each role MUST belong to its institution (§2), and admin roles SHOULD be held by multisignature accounts.

11.3 Keys, KYC data and `issuerSecret` MUST NOT be published. Everything else in this repository is open source under Apache-2.0.

## 12. Known limits

- A false story told to the payer (APP fraud) is reversible within the window if reported, not prevented.
- On a public chain every balance and transfer is visible by address; no address is linked on chain to a name, but an address linked off chain exposes its history.
- Holder-to-holder transfers carry no escrow.
- Expired points held in an unclaimed gift cannot be recovered.
- The Worker is a single relayer; a production deployment needs redundancy and an independent indexer.
- Refunding a site-access purchase revokes the holder's whole entitlement for that product, including entries bought with another payment for the same product. Points awarded for a refunded payment are not taken back.
- A pay code is not used up when a request is created from it, and request creation is not rate-limited; a deployment should add per-merchant limits.
- If a transaction is mined but its receipt is not seen (for example a timeout), the Worker's index can miss it; a production deployment needs reconciliation from chain events.
- Nothing here has been audited. Do not use with real money.
