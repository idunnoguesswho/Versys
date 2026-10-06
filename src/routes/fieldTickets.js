/**
 * POST /api/field-tickets/:refNbr/send
 *
 * Automates the "Export Field Ticket to PDF and send for e-signature" SOP
 * (docs/sop/field-ticket-pdf-esign.md) for one ticket:
 *   1. confirm the ticket exists in Acumatica,
 *   2. stamp Customer Sent Date (defaults to today, Edmonton time),
 *   3. render the UnPriced / Weekly report as PDF,
 *   4. send it via Adobe Sign with business-day reminders.
 *
 * Request body (JSON):
 *   { "signerName": "Jane Client", "signerEmail": "jane@client.com",
 *     "sentDate": "2026-10-06"  (optional),
 *     "force": false            (optional — allow re-sending a sent ticket) }
 *
 * The signer still comes from the caller: the LEM List lives in a SharePoint
 * spreadsheet / BinManager that this Worker can't read yet.
 */
import { AcumaticaClient, acumaticaConfig } from "../lib/acumatica.js";
import { AdobeSignClient, adobeSignConfig } from "../lib/adobesign.js";

// Versys field ticket numbers look like "VC-0001806"; allow similar prefixes.
const REF_NBR_RE = /^[A-Z]{1,5}-\d{4,10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Edmonton as YYYY-MM-DD (en-CA formats dates that way). */
function todayInEdmonton() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function sendFieldTicket(request, env, refNbr) {
  // ---- Validate input -----------------------------------------------------
  refNbr = decodeURIComponent(refNbr).toUpperCase();
  if (!REF_NBR_RE.test(refNbr)) return json({ error: "Invalid field ticket number" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const signerName = String(body.signerName || "").trim();
  const signerEmail = String(body.signerEmail || "").trim().toLowerCase();
  const sentDate = body.sentDate || todayInEdmonton();
  if (!signerName || signerName.length > 200) return json({ error: "signerName is required" }, 400);
  if (!EMAIL_RE.test(signerEmail)) return json({ error: "signerEmail is invalid" }, 400);
  if (!DATE_RE.test(sentDate)) return json({ error: "sentDate must be YYYY-MM-DD" }, 400);

  // ---- Guard against double-sends ------------------------------------------
  if (!body.force) {
    const prior = await env.DB.prepare(
      "SELECT adobe_agreement, sent_date FROM field_ticket_sends WHERE ref_nbr = ? AND status = 'sent' ORDER BY id DESC LIMIT 1"
    )
      .bind(refNbr)
      .first();
    if (prior) {
      return json(
        { error: "Already sent", agreementId: prior.adobe_agreement, sentDate: prior.sent_date, hint: "Pass force: true to resend" },
        409
      );
    }
  }

  // ---- Build clients (throws if config is incomplete) ----------------------
  let acu, adobe;
  try {
    acu = new AcumaticaClient(acumaticaConfig(env));
    adobe = new AdobeSignClient(adobeSignConfig(env));
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  // Record the attempt up front so a mid-way failure is visible later.
  const { meta } = await env.DB.prepare(
    "INSERT INTO field_ticket_sends (ref_nbr, sent_date, signer_name, signer_email, status) VALUES (?, ?, ?, ?, 'started')"
  )
    .bind(refNbr, sentDate, signerName, signerEmail)
    .run();
  const logId = meta.last_row_id;

  /** Update the log row; called on success and on failure. */
  const finish = (fields) => {
    const cols = Object.keys(fields);
    const sets = cols.map((c) => `${c} = ?`).join(", ");
    return env.DB.prepare(
      `UPDATE field_ticket_sends SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
      .bind(...cols.map((c) => fields[c]), logId)
      .run();
  };

  // ---- Run the workflow, tracking which step we're on ------------------------
  let step = "lookup";
  try {
    const ticket = await acu.getFieldTicket(refNbr);
    if (!ticket) {
      await finish({ status: "failed", failed_step: step, error: "Not found" });
      return json({ error: `Field ticket ${refNbr} not found in Acumatica` }, 404);
    }

    // SOP order matters: stamp the date BEFORE rendering so the PDF matches.
    step = "set_sent_date";
    await acu.setCustomerSentDate(refNbr, sentDate);

    step = "render_pdf";
    const pdfBytes = await acu.getReportPdf(refNbr);

    step = "adobe_send";
    const agreementId = await adobe.sendForSignature({
      pdfBytes,
      fileName: `${refNbr} UnPriced Weekly.pdf`,
      agreementName: `Field Ticket ${refNbr} – LEM Approval`,
      signerEmail,
      signerName,
      message: `Please review and sign field ticket ${refNbr}. Thank you, Versys.`,
    });

    await finish({ status: "sent", adobe_agreement: agreementId });
    return json({ ok: true, refNbr, sentDate, agreementId });
  } catch (err) {
    // Log only the message — never request bodies or tokens.
    const message = String(err.message || err).slice(0, 500);
    await finish({ status: "failed", failed_step: step, error: message });
    return json({ error: message, failedStep: step }, 502);
  }
}
