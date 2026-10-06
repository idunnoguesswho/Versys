/**
 * Adobe Acrobat Sign REST API v6 client.
 *
 * Mirrors steps 14–16 of the manual SOP:
 *   - upload the PDF,
 *   - add the client approver as signer,
 *   - place Name + Signature fields at the bottom of the LAST page,
 *   - set reminders to every business day, and send.
 *
 * To place fields programmatically we create the agreement in the AUTHORING
 * state first (a draft), add the fields, then move it to IN_PROCESS (sent).
 */

/** Adobe's reminder enum for "every business day" in the web UI. */
const REMINDER_EVERY_BUSINESS_DAY = "WEEKDAILY_UNTIL_SIGNED";

export function adobeSignConfig(env) {
  if (!env.ADOBE_SIGN_ACCESS_TOKEN) {
    throw new Error("Adobe Sign config missing: ADOBE_SIGN_ACCESS_TOKEN");
  }
  return {
    accessToken: env.ADOBE_SIGN_ACCESS_TOKEN,
    // Discovery host; the account's real API host is looked up via /baseUris.
    discoveryUrl: (env.ADOBE_SIGN_DISCOVERY_URL || "https://api.adobesign.com").replace(/\/+$/, ""),
    // Optional: send on behalf of a specific Adobe user (shared office account).
    senderEmail: env.ADOBE_SIGN_SENDER_EMAIL || null,
    // Field placement on the last page, in PDF points (72 pt = 1 inch).
    // Kept configurable because the UnPriced/Weekly layout may change and
    // Adobe's coordinate origin should be confirmed on the first test send.
    placement: JSON.parse(
      env.ADOBE_SIGN_FIELD_PLACEMENT ||
        JSON.stringify({
          signature: { left: 72, top: 110, width: 220, height: 36 },
          name: { left: 330, top: 110, width: 200, height: 24 },
        })
    ),
    readyTimeoutMs: Number(env.ADOBE_SIGN_READY_TIMEOUT_MS || 30000),
  };
}

export class AdobeSignClient {
  /** @param {ReturnType<typeof adobeSignConfig>} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.apiBase = null;
  }

  /** Common auth headers; x-api-user lets an admin token act as the office sender. */
  headers(extra = {}) {
    const h = { Authorization: `Bearer ${this.cfg.accessToken}`, ...extra };
    if (this.cfg.senderEmail) h["x-api-user"] = `email:${this.cfg.senderEmail}`;
    return h;
  }

  /** Look up which regional shard (na1, na2, …) this account lives on. */
  async resolveBase() {
    if (this.apiBase) return this.apiBase;
    const res = await fetch(`${this.cfg.discoveryUrl}/api/rest/v6/baseUris`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Adobe Sign baseUris failed: HTTP ${res.status}`);
    const { apiAccessPoint } = await res.json();
    this.apiBase = `${apiAccessPoint.replace(/\/+$/, "")}/api/rest/v6`;
    return this.apiBase;
  }

  /** JSON request helper with a readable error that includes Adobe's error code. */
  async call(path, init = {}) {
    const base = await this.resolveBase();
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: this.headers({
        ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      }),
    });
    if (!res.ok) {
      let code = "";
      try {
        code = (await res.json()).code || "";
      } catch {
        /* body wasn't JSON — status alone will do */
      }
      const err = new Error(`Adobe Sign ${init.method || "GET"} ${path} failed: HTTP ${res.status} ${code}`.trim());
      err.status = res.status;
      err.code = code;
      throw err;
    }
    // Some endpoints (PUT state / formFields) return an empty body.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Step 1: upload the PDF as a transient document (valid for 7 days). */
  async uploadPdf(pdfBytes, fileName) {
    const form = new FormData();
    form.append("File-Name", fileName);
    form.append("Mime-Type", "application/pdf");
    form.append("File", new Blob([pdfBytes], { type: "application/pdf" }), fileName);
    const json = await this.call("/transientDocuments", { method: "POST", body: form });
    return json.transientDocumentId;
  }

  /**
   * Full send: upload → draft agreement → fields on last page → send.
   * Returns the Adobe agreement ID.
   */
  async sendForSignature({ pdfBytes, fileName, agreementName, signerEmail, signerName, message }) {
    const transientDocumentId = await this.uploadPdf(pdfBytes, fileName);

    // Step 2: create the agreement as a draft so we can place fields.
    const { id: agreementId } = await this.call("/agreements", {
      method: "POST",
      body: JSON.stringify({
        name: agreementName,
        message,
        fileInfos: [{ transientDocumentId }],
        participantSetsInfo: [
          {
            order: 1,
            role: "SIGNER",
            memberInfos: [{ email: signerEmail, name: signerName }],
          },
        ],
        signatureType: "ESIGN",
        state: "AUTHORING",
        reminderFrequency: REMINDER_EVERY_BUSINESS_DAY,
      }),
    });

    // Step 3: find the last page and the signer's participant-set ID.
    const lastPage = await this.waitForPageCount(agreementId);
    const members = await this.call(`/agreements/${agreementId}/members`);
    const assignee = members.participantSets[0].id;

    // Step 4: place Signature + Name fields at the bottom of the last page.
    const { signature, name } = this.cfg.placement;
    await this.call(`/agreements/${agreementId}/formFields`, {
      method: "PUT",
      body: JSON.stringify({
        fields: [
          {
            name: "ClientSignature",
            inputType: "SIGNATURE",
            contentType: "SIGNATURE",
            assignee,
            required: true,
            locations: [{ pageNumber: lastPage, ...signature }],
          },
          {
            name: "ClientName",
            inputType: "TEXT_FIELD",
            contentType: "SIGNER_NAME",
            assignee,
            required: true,
            locations: [{ pageNumber: lastPage, ...name }],
          },
        ],
      }),
    });

    // Step 5: send it ("Review & Send" → "Send").
    await this.call(`/agreements/${agreementId}/state`, {
      method: "PUT",
      body: JSON.stringify({ state: "IN_PROCESS" }),
    });

    return agreementId;
  }

  /**
   * Adobe processes uploaded files asynchronously; the documents list isn't
   * available until it finishes. Poll until we can read the page count.
   */
  async waitForPageCount(agreementId) {
    const deadline = Date.now() + this.cfg.readyTimeoutMs;
    let delay = 500;
    while (Date.now() < deadline) {
      try {
        const { documents } = await this.call(`/agreements/${agreementId}/documents`);
        if (documents?.length) {
          // Single-file agreement, but sum in case more files are added later.
          return documents.reduce((n, d) => n + (d.numPages || 0), 0);
        }
      } catch (err) {
        // 404 = still processing; anything else is a real error.
        if (err.status !== 404) throw err;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
    }
    throw new Error(`Adobe Sign document not ready after ${this.cfg.readyTimeoutMs} ms`);
  }
}
