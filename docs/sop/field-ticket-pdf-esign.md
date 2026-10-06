# SOP: Export a Field Ticket to PDF and Send for E-Signature

| | |
|---|---|
| **Owner** | Office Team |
| **System(s)** | Acumatica (Versys US), Adobe Acrobat Sign, BinManager / LEM List signatures |
| **Source** | [Scribe walkthrough](https://scribehow.com/o/Sc44ZG3zTZejcNli7gmBkQ/viewer/How_to_Export_Field_Ticket_Details_to_PDF_in_Acumatica__goJ3EyxPRf6hm2fXIEvKPg) (has screenshots for every step) |
| **Last reviewed** | 2026-10-06 |

## Why this matters

A field ticket (LEM — Labour, Equipment, Materials) can't be invoiced until the
client has approved it. This procedure stamps the ticket with the date it was
sent to the customer, produces the unpriced weekly PDF the client signs, and
sends it through Adobe so we get a tracked, legally signed approval with
automatic reminders.

## Before you start

- You are logged in to Acumatica under the **Versys US** company.
- You know which client contact approves LEMs for the job. Look them up in
  either:
  - [LEM List signatures.xlsx](https://versysgroup.sharepoint.com/:x:/r/sites/OfficeTeam/_layouts/15/Doc.aspx?sourcedoc=%7B4930BA18-FF0A-4A43-90E0-49A88D016C16%7D&file=LEM%20List%20signatures.xlsx&action=default&mobileredirect=true) (SharePoint), **or**
  - BinManager (client approver name and email).
- You have an Adobe Acrobat Sign account.

## Procedure

### 1. Find the field tickets to send

1. Open the generic inquiry **GI990224**:
   <https://versys.acumatica.com/(W(5))/Main?CompanyID=Versys+US&ScreenId=GI990224>
2. Click **Field Ticket list with Amount**.
3. Click the **FT Send** tab/view.
4. Open the **filter settings**, set the filters you need, then click **Apply**.

### 2. Stamp the Customer Sent Date

5. Click the field ticket number (e.g. `VC-0001806`) to select it.
6. Open the selected field ticket.
7. In **Customer Sent Date**, pick **today's date**.
8. Click **Save**.

> **Check:** the date must be saved *before* you run the report, otherwise the
> PDF and the ticket record won't match.

### 3. Generate the PDF

9. Open the **More actions** menu (`…`).
10. Click **UnPriced / Weekly**.
11. In the report viewer, click **Export** → **PDF**. Save the file.

### 4. Send for e-signature in Adobe

12. In Adobe Acrobat Sign, start a new agreement and upload the PDF.
13. Add the client approver (from the LEM List / BinManager) as the signer.
14. Place a **Name** field and a **Signature** field at the **bottom of the
    last page** of the document.
15. Click **Review & Send**.
16. Set **Reminder** to **Every business day**, then click **Send**.

## Done when

- The ticket shows a Customer Sent Date of today in Acumatica.
- The agreement appears in Adobe as **Out for signature** to the correct client.

## Troubleshooting

| Problem | Fix |
|---|---|
| Ticket doesn't appear in **FT Send** | Clear/adjust the filter and click **Apply** again; confirm you're in **Versys US**. |
| **UnPriced / Weekly** isn't in More actions | Save the ticket first; the action list refreshes after save. |
| No approver listed for the client | Check BinManager; if still missing, ask the project manager before sending. |

## Automation

This procedure is being automated by the Versys Worker — see
[`docs/automation/field-ticket-esign.md`](../automation/field-ticket-esign.md).
Until that is live, follow the manual steps above.
