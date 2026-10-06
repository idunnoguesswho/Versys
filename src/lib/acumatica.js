/**
 * Acumatica contract-based REST API client.
 *
 * Why OAuth instead of cookie login: a bearer token is stateless, so the
 * Worker doesn't have to juggle ASP.NET session cookies or remember to log out
 * (cookie sessions count against Acumatica's concurrent-user license limit).
 *
 * Field tickets and the "UnPriced / Weekly" report are Versys customizations,
 * so they are NOT in Acumatica's Default endpoint. An Acumatica admin must
 * expose both through a custom web service endpoint (screen SM207060) — see
 * docs/automation/field-ticket-esign.md. Every entity/field name used here is
 * read from config so it can match whatever that endpoint ends up calling them.
 */

/**
 * Build the client config from Worker env. Throws early with a clear list of
 * what's missing so a misconfigured deploy fails loudly, not halfway through.
 */
export function acumaticaConfig(env) {
  const required = [
    "ACUMATICA_BASE_URL",
    "ACUMATICA_TENANT",
    "ACUMATICA_CLIENT_ID",
    "ACUMATICA_CLIENT_SECRET",
    "ACUMATICA_USERNAME",
    "ACUMATICA_PASSWORD",
    "ACUMATICA_ENDPOINT_NAME",
    "ACUMATICA_ENDPOINT_VERSION",
    "ACUMATICA_FT_ENTITY",
    "ACUMATICA_FT_KEY_FIELD",
    "ACUMATICA_FT_SENT_DATE_FIELD",
    "ACUMATICA_REPORT_ENTITY",
    "ACUMATICA_REPORT_PARAM",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Acumatica config missing: ${missing.join(", ")}`);
  }

  return {
    // Strip any trailing slash so URL joins below are predictable.
    baseUrl: env.ACUMATICA_BASE_URL.replace(/\/+$/, ""),
    tenant: env.ACUMATICA_TENANT,
    clientId: env.ACUMATICA_CLIENT_ID,
    clientSecret: env.ACUMATICA_CLIENT_SECRET,
    username: env.ACUMATICA_USERNAME,
    password: env.ACUMATICA_PASSWORD,
    endpointName: env.ACUMATICA_ENDPOINT_NAME,
    endpointVersion: env.ACUMATICA_ENDPOINT_VERSION,
    ftEntity: env.ACUMATICA_FT_ENTITY,
    ftKeyField: env.ACUMATICA_FT_KEY_FIELD,
    ftSentDateField: env.ACUMATICA_FT_SENT_DATE_FIELD,
    reportEntity: env.ACUMATICA_REPORT_ENTITY,
    reportParam: env.ACUMATICA_REPORT_PARAM,
    // How long to wait for the report server before giving up (ms).
    reportTimeoutMs: Number(env.ACUMATICA_REPORT_TIMEOUT_MS || 60000),
  };
}

export class AcumaticaClient {
  /** @param {ReturnType<typeof acumaticaConfig>} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.token = null;
  }

  /** Base URL for the custom endpoint, e.g. https://x/entity/VersysExt/24.200.001 */
  get entityRoot() {
    const { baseUrl, endpointName, endpointVersion } = this.cfg;
    return `${baseUrl}/entity/${encodeURIComponent(endpointName)}/${encodeURIComponent(endpointVersion)}`;
  }

  /**
   * Get an OAuth access token using the resource-owner password grant.
   * The connected application must be registered in Acumatica (SM303010)
   * with the "Resource Owner Password Credentials" flow enabled.
   * Multi-tenant sites identify the tenant as "username@TenantName".
   */
  async login() {
    const { baseUrl, clientId, clientSecret, username, password, tenant } = this.cfg;
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
      username: `${username}@${tenant}`,
      password,
      scope: "api",
    });

    const res = await fetch(`${baseUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      // Never echo the request body — it contains the password.
      throw new Error(`Acumatica login failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    this.token = json.access_token;
  }

  /** Shared fetch wrapper: adds auth, logs in lazily. */
  async request(path, init = {}) {
    if (!this.token) await this.login();
    const url = path.startsWith("http") ? path : `${this.entityRoot}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  /**
   * Fetch one field ticket by its reference number (e.g. "VC-0001806").
   * Uses $filter rather than a key path because custom entities don't always
   * declare their keys the way GET /Entity/{key} expects.
   */
  async getFieldTicket(refNbr) {
    const { ftEntity, ftKeyField } = this.cfg;
    // OData string literal: single quotes are escaped by doubling them.
    const filter = `${ftKeyField} eq '${refNbr.replace(/'/g, "''")}'`;
    const res = await this.request(
      `/${encodeURIComponent(ftEntity)}?$filter=${encodeURIComponent(filter)}&$top=1`
    );
    if (!res.ok) throw new Error(`Field ticket lookup failed: HTTP ${res.status}`);
    const rows = await res.json();
    return rows[0] || null;
  }

  /**
   * Set the Customer Sent Date on a field ticket — equivalent to steps 7–8 of
   * the manual SOP (pick date, Save). Acumatica's PUT is an upsert keyed on
   * the entity's key fields, so passing the ref number updates that record.
   *
   * @param {string} refNbr  Field ticket number.
   * @param {string} isoDate Date as YYYY-MM-DD (company-local date).
   */
  async setCustomerSentDate(refNbr, isoDate) {
    const { ftEntity, ftKeyField, ftSentDateField } = this.cfg;
    const body = {
      [ftKeyField]: { value: refNbr },
      // Acumatica DateTime fields accept ISO-8601; midnight keeps it a pure date.
      [ftSentDateField]: { value: `${isoDate}T00:00:00` },
    };
    const res = await this.request(`/${encodeURIComponent(ftEntity)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Setting Customer Sent Date failed: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Run the "UnPriced / Weekly" report for one ticket and return the PDF bytes.
   *
   * Acumatica's async report pattern:
   *   1. PUT the report entity with its parameters → 202 Accepted + Location header.
   *   2. GET the Location URL → 202 while rendering, 200 with the PDF when done.
   */
  async getReportPdf(refNbr) {
    const { reportEntity, reportParam, reportTimeoutMs } = this.cfg;

    const start = await this.request(`/${encodeURIComponent(reportEntity)}`, {
      method: "PUT",
      body: JSON.stringify({ [reportParam]: { value: refNbr } }),
    });
    if (start.status !== 202) {
      throw new Error(`Report request failed: HTTP ${start.status}`);
    }
    const location = start.headers.get("Location");
    if (!location) throw new Error("Report request returned no Location header");
    // Location is usually relative to the site root (e.g. /entity/...).
    const pollUrl = new URL(location, this.cfg.baseUrl).toString();

    // Poll with gentle backoff until the PDF is ready or we time out.
    const deadline = Date.now() + reportTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      const res = await this.request(pollUrl, { headers: { Accept: "application/pdf" } });
      if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
      if (res.status !== 202) throw new Error(`Report polling failed: HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
    throw new Error(`Report not ready after ${reportTimeoutMs} ms`);
  }
}
