# Published HubSpot quotes left live after the 2026-10-14 test-data purge

All 11 `merchant_applications` rows were deleted from the EasyOB database on 2026-10-14 — they
were all tests. **Eight of them had PUBLISHED HubSpot quotes, and deleting the EasyOB row does
not touch those.** They are still live and still payable.

A published quote cannot be deleted or edited through the API (`PUBLISHED_QUOTE_CANNOT_BE_DELETED`,
and `400 LOCKED` on edit), and setting `hs_status: VOID` is itself an edit — so **voiding is
HubSpot-UI-only**. That is why this is a human checklist and not a script.

## Why it matters that these are still live

EasyOB detects a paid quote by finding its HubSpot subscription and matching it back to an
application row. With the row gone, that match can never happen. So if anyone pays one of these:

- the subscription appears in HubSpot and money moves,
- no acceptance is recorded, no account-creation email is sent,
- no AIO tenant and no Adyen KYC link is provisioned,
- and nothing alerts, because an unmatched subscription is not an error state.

This matters more than it did a day ago: AIO tenant provisioning went live on 2026-10-14, so the
pre-purge behaviour of "nothing happens anyway" is no longer the baseline.

## The list

Void each of these in the HubSpot UI.

| Merchant | Quote ID | Deal ID | Published | E-sign |
|---|---|---|---|---|
| Shaheer's Second test company | `330655913691` | `350251003634` | 2026-09-25 | SIGNED |
| Shaheer's Second test company | `333276097211` | `353408196322` | 2026-10-07 | PENDING_SIGNATURE |
| Shaheer's Second test company | `333345545954` | `352942863067` | 2026-10-09 | SIGNED |
| Shaheer's Test | `333374546667` | `353408427736` | 2026-10-09 | PENDING_SIGNATURE |
| EasyOB Test E2E | `333561204420` | `353525309155` | 2026-10-12 | SIGNED |
| McDonald's - 6959 Atlantic Ave | `333704292070` | `353737532145` | 2026-10-13 | PENDING_SIGNATURE |
| 10/13 DBA | `333954511548` | `354160551630` | 2026-10-14 | PENDING_SIGNATURE |
| bob bob bob | `333972700885` | `354154075850` | 2026-10-14 | PENDING_SIGNATURE |

Three are already SIGNED — someone completed the e-signature on the hosted page but never paid,
which is the `hasSignedWithoutPaying()` state. Signing is not accepting; only the checkout is.

The deals themselves are left alone deliberately. They are real CRM records a human may want, and
a deal with no quote is harmless — it is the payable quote that is the hazard.

**Delete this file once the eight are voided.**

## Recovery

A full dump of every deleted row (`merchant_applications` + `customer_login_tokens`) was written
to `~/easyob-db-backup-20261014.json` immediately before the delete. It is deliberately outside
the repo: it carries merchant names, addresses, emails and phone numbers.
