-- Audit log of field tickets sent for client e-signature.
-- Lets us (a) prevent accidental double-sends and (b) see where a failed
-- send stopped, since the Acumatica date stamp happens before the Adobe send.
CREATE TABLE IF NOT EXISTS field_ticket_sends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_nbr         TEXT    NOT NULL,              -- Acumatica field ticket, e.g. VC-0001806
  sent_date       TEXT    NOT NULL,              -- Customer Sent Date stamped (YYYY-MM-DD)
  signer_name     TEXT    NOT NULL,
  signer_email    TEXT    NOT NULL,
  status          TEXT    NOT NULL,              -- 'started' | 'sent' | 'failed'
  failed_step     TEXT,                          -- which step failed, when status = 'failed'
  error           TEXT,                          -- short error message (no secrets)
  adobe_agreement TEXT,                          -- Adobe agreement ID once sent
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_field_ticket_sends_ref ON field_ticket_sends (ref_nbr);
