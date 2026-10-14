# Published HubSpot quotes left live after the 2026-10-14 test-data purge

All 11 `merchant_applications` rows were deleted from the EasyOB database on 2026-10-14 — they
were all tests. **Eight of them had PUBLISHED HubSpot quotes, and deleting the EasyOB row does
not touch those.** They are still live and still payable.

A published quote cannot be deleted or edited through the API (`PUBLISHED_QUOTE_CANNOT_BE_DELETED`,
and `400 LOCKED` on edit), and setting `hs_status: VOID` is itself an edit — so **voiding is
HubSpot-UI-only**. That is why this is a human checklist and not a script.

**This is now PROVEN, not inferred** (2026-10-14). It had only ever been asserted in a comment.
Probed live against quote `333972700885`:

```
PATCH /crm/v3/objects/quotes/333972700885  { "properties": { "hs_status": "VOID" } }
→ 400  Validation Error: Published Quote cannot be edited.
       subCategory: LOCKED   context.lockReason: ["Published"]
```

The quote was unchanged afterwards — `hs_status` still `APPROVAL_NOT_NEEDED` and
`hs_lastmodifieddate` untouched. So there is no API path to voiding, and no amount of scope or a
different token changes it: the refusal is about the object's published state, not permissions.

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

Each link opens the quote record directly. Void from the record's actions menu.

| # | Merchant | E-sign | Open the record |
|---|---|---|---|
| 1 | Shaheer's Second test company | SIGNED | https://app.hubspot.com/contacts/244508708/record/0-14/330655913691 |
| 2 | Shaheer's Second test company | PENDING | https://app.hubspot.com/contacts/244508708/record/0-14/333276097211 |
| 3 | Shaheer's Second test company | SIGNED | https://app.hubspot.com/contacts/244508708/record/0-14/333345545954 |
| 4 | Shaheer's Test | PENDING | https://app.hubspot.com/contacts/244508708/record/0-14/333374546667 |
| 5 | EasyOB Test E2E | SIGNED | https://app.hubspot.com/contacts/244508708/record/0-14/333561204420 |
| 6 | McDonald's - 6959 Atlantic Ave | PENDING | https://app.hubspot.com/contacts/244508708/record/0-14/333704292070 |
| 7 | 10/13 DBA | PENDING | https://app.hubspot.com/contacts/244508708/record/0-14/333954511548 |
| 8 | bob bob bob | PENDING | https://app.hubspot.com/contacts/244508708/record/0-14/333972700885 |

Deal ids, if you need them: `350251003634`, `353408196322`, `352942863067`, `353408427736`,
`353525309155`, `353737532145`, `354160551630`, `354154075850`.

To confirm afterwards, re-read `hs_status` on each — a voided quote reads `VOID` instead of
`APPROVAL_NOT_NEEDED`. That read is available over the API even though the write is not.

Three are already SIGNED — someone completed the e-signature on the hosted page but never paid,
which is the `hasSignedWithoutPaying()` state. Signing is not accepting; only the checkout is.

The deals themselves are left alone deliberately. They are real CRM records a human may want, and
a deal with no quote is harmless — it is the payable quote that is the hazard.

**Delete this file once the eight are voided.**

## Recovery

A full dump of every deleted row (`merchant_applications` + `customer_login_tokens`) was written
to `~/easyob-db-backup-20261014.json` immediately before the delete. It is deliberately outside
the repo: it carries merchant names, addresses, emails and phone numbers.
