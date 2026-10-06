# Automation: Field Ticket → PDF → Adobe E-Sign

Automates the manual SOP in [`docs/sop/field-ticket-pdf-esign.md`](../sop/field-ticket-pdf-esign.md).

**Status:** first draft — code is written but has **not** been run against the
real Acumatica or Adobe accounts yet. Items marked ⚠️ must be confirmed.

## How it works

```
POST /api/field-tickets/VC-0001806/send
Authorization: Bearer <API_TOKEN>
{ "signerName": "Jane Client", "signerEmail": "jane@client.com" }
```

| SOP step | What the Worker does | Code |
|---|---|---|
| 1–6 Find ticket | Looks the ticket up by ref number | `AcumaticaClient.getFieldTicket` |
| 7–8 Customer Sent Date + Save | `PUT` the ticket with today's date (Edmonton) | `AcumaticaClient.setCustomerSentDate` |
| 9–11 UnPriced / Weekly → PDF | Runs the report via the async report API, polls for the PDF | `AcumaticaClient.getReportPdf` |
| 12–16 Adobe send | Uploads PDF, draft agreement, Name + Signature on last page, reminders every business day, send | `AdobeSignClient.sendForSignature` |

Each attempt is logged in the D1 table `field_ticket_sends` (status, which step
failed, Adobe agreement ID). A ticket that was already sent returns **409**
unless the request includes `"force": true`.

> **Order matters:** the date is stamped *before* the PDF is rendered (same as
> the SOP). If the Adobe step then fails, the ticket will show a sent date but
> no agreement — check `field_ticket_sends` for `status = 'failed'`.

## One-time setup

### 1. Acumatica (needs an Acumatica admin)

Field tickets and the UnPriced / Weekly report are customizations, so they
must be exposed through a **custom web service endpoint**:

1. **Web Service Endpoints (SM207060)** → extend `Default` (e.g. name
   `VersysExt`). Note the version.
2. Add the **field ticket screen** as an entity (e.g. `FieldTicket`) with the
   ticket number and **Customer Sent Date** fields.
3. Add the **UnPriced / Weekly** report as an entity (e.g.
   `FieldTicketUnpricedWeekly`) with the ticket-number parameter.
4. **Connected Applications (SM303010)** → new app, flow *Resource Owner
   Password Credentials*. Copy the client ID and secret.
5. Create a dedicated API user whose role can only edit field tickets and run
   that report (least privilege).

⚠️ Confirm: the exact entity, field and parameter names chosen above; and that
the tenant login format `username@Versys US` works for OAuth on this site.

### 2. Adobe Acrobat Sign

1. Create an **integration key** (Account → Acrobat Sign API → API
   Information) with `agreement_read`, `agreement_write`, `agreement_send`.
2. Optional: set `ADOBE_SIGN_SENDER_EMAIL` to the shared office sender so
   agreements show up in that mailbox.

⚠️ Confirm on the first test send: Name/Signature fields land at the bottom of
the last page. Positions are in PDF points and can be tuned without a code
change via `ADOBE_SIGN_FIELD_PLACEMENT`, e.g.
`{"signature":{"left":72,"top":110,"width":220,"height":36},"name":{"left":330,"top":110,"width":200,"height":24}}`.
A sturdier long-term option is adding Adobe **text tags** (e.g.
`{{Sig_es_:signer1:signature}}`) to the report layout itself.

### 3. Worker config (Windows PowerShell)

```powershell
# Apply the D1 schema
npx wrangler d1 migrations apply versys --remote

# Secrets — each command prompts for the value
npx wrangler secret put API_TOKEN
npx wrangler secret put ACUMATICA_CLIENT_ID
npx wrangler secret put ACUMATICA_CLIENT_SECRET
npx wrangler secret put ACUMATICA_USERNAME
npx wrangler secret put ACUMATICA_PASSWORD
npx wrangler secret put ADOBE_SIGN_ACCESS_TOKEN
```

Then uncomment and fill in the `[vars]` block in `wrangler.toml`.

For local dev, copy `.env.example` to `.dev.vars`, fill it in, and run
`npx wrangler dev`.

### 4. Test call (PowerShell)

```powershell
$headers = @{ Authorization = "Bearer $env:VERSYS_API_TOKEN" }
$body = @{ signerName = "Test Signer"; signerEmail = "you@versys.example" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://versys.ekat.ca/api/field-tickets/VC-0001806/send" `
  -Headers $headers -ContentType "application/json" -Body $body
```

Use a test ticket and send to yourself first.

## Not automated yet

- **Signer lookup.** The approver still comes from the caller. Next step:
  read the LEM List spreadsheet via Microsoft Graph, or BinManager's API if it
  has one, keyed by customer/project.
- **Batch sending** of everything in the *FT Send* view.
- **Staff UI.** Calls are API-only for now; put Cloudflare Access (SSO) in front
  before adding a browser page.
