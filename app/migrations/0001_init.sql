-- Nokor Pass reference implementation, D1 schema.
-- The chain is the source of truth for passes, money, access and points; the
-- tables below hold off-chain protocol state (vault ciphertext, sessions, pay
-- codes, requests) and an index of events the Worker relayed (SPEC §9.5).

-- Wallet vaults: ciphertext and public identifiers only (SPEC §8.2).
CREATE TABLE vaults (
  id               TEXT PRIMARY KEY,
  address          TEXT UNIQUE,
  pin_salt         TEXT NOT NULL,
  pin_envelope     TEXT NOT NULL,
  passkey_envelope TEXT,
  passkey_id       TEXT,
  wallet_envelope  TEXT NOT NULL,
  argon2_params    TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE challenges (
  address    TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Staff keys: issuer (immigration), gate, operator. Stored hashed.
CREATE TABLE api_keys (
  key_hash   TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('issuer', 'gate', 'operator')),
  label      TEXT NOT NULL,
  site_ids   TEXT,          -- JSON array, gates only
  created_at INTEGER NOT NULL
);

-- Short-lived codes a holder shows to be paid, admitted or issued (SPEC §9.1).
CREATE TABLE pay_codes (
  code       TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pay_codes_address ON pay_codes(address);

-- Registered names and attributes of merchants (mirrors NokorRegistry).
CREATE TABLE merchants (
  address    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  province   TEXT NOT NULL,
  risk_class INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Reference fares for regulated categories (SPEC §5.9).
CREATE TABLE fares (
  category TEXT NOT NULL,
  route    TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
  amount   INTEGER NOT NULL,   -- minor units
  PRIMARY KEY (category, route, currency)
);

-- Requests started by a payee or a gate, approved on the holder's phone.
CREATE TABLE requests (
  id           TEXT PRIMARY KEY,   -- 0x + 32 bytes; also the on-chain ref
  kind         TEXT NOT NULL CHECK (kind IN ('payment', 'purchase', 'entry')),
  holder       TEXT NOT NULL,
  merchant     TEXT,
  currency     TEXT,
  amount       INTEGER,
  description  TEXT,
  route        TEXT,
  reference    INTEGER,            -- reference fare, minor units
  flagged      INTEGER NOT NULL DEFAULT 0,
  product_id   INTEGER,
  site_id      TEXT,
  gate_label   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'approved', 'declined', 'expired', 'failed')),
  error        TEXT,
  tx_hash      TEXT,
  payment_id   INTEGER,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX requests_holder ON requests(holder, status);

-- ---------------------------------------------------------------- event index

CREATE TABLE passes (
  pass_id          INTEGER PRIMARY KEY,
  holder           TEXT NOT NULL,
  category         TEXT NOT NULL,
  previous_pass_id INTEGER NOT NULL,
  issued_at        INTEGER NOT NULL,
  valid_until      INTEGER NOT NULL,
  closed_at        INTEGER,
  tx_hash          TEXT
);
CREATE INDEX passes_holder ON passes(holder);

CREATE TABLE payments (
  currency    TEXT NOT NULL,
  payment_id  INTEGER NOT NULL,
  ref         TEXT NOT NULL,
  payer       TEXT NOT NULL,
  merchant    TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('Escrowed', 'Disputed', 'Released', 'Refunded')),
  disputed    INTEGER NOT NULL DEFAULT 0,
  release_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  tx_hash     TEXT,
  PRIMARY KEY (currency, payment_id)
);
CREATE INDEX payments_payer ON payments(payer);
CREATE INDEX payments_merchant ON payments(merchant, status);

CREATE TABLE topups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  holder     TEXT NOT NULL,
  currency   TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  tx_hash    TEXT
);

CREATE TABLE exits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('cashout', 'redeem')),
  account    TEXT NOT NULL,
  currency   TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  ref        TEXT NOT NULL,
  at         INTEGER NOT NULL,
  tx_hash    TEXT
);

CREATE TABLE products (
  product_id       INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  payee            TEXT NOT NULL,
  price_usd        INTEGER NOT NULL,
  price_khr        INTEGER NOT NULL,
  validity_seconds INTEGER NOT NULL,
  entries          INTEGER NOT NULL,
  sites            TEXT NOT NULL,     -- JSON array of site ids
  description      TEXT
);

CREATE TABLE grants (
  holder     TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  pass_id    INTEGER NOT NULL,
  ref        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (ref)
);
CREATE INDEX grants_holder ON grants(holder);

CREATE TABLE visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pass_id    INTEGER NOT NULL,
  holder     TEXT NOT NULL,
  site_id    TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  tx_hash    TEXT
);

-- award | gift | claim | cancel | redeem
CREATE TABLE point_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  account        TEXT NOT NULL,
  pass_id        INTEGER,          -- awarded-to / redeemer pass
  earned_on_pass INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  gift_id        INTEGER,
  return_trip    INTEGER NOT NULL DEFAULT 0,
  spread         INTEGER NOT NULL DEFAULT 0,
  ref            TEXT,
  at             INTEGER NOT NULL,
  tx_hash        TEXT
);
CREATE INDEX point_events_account ON point_events(account);

CREATE TABLE gifts (
  gift_id        INTEGER PRIMARY KEY,
  giver          TEXT NOT NULL,
  earned_on_pass INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'cancelled')),
  recipient      TEXT,
  created_at     INTEGER NOT NULL
);

-- Point offers: the state's baseline use and merchants' offers (SPEC §7.6).
CREATE TABLE offers (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  points      INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  description TEXT,
  baseline    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE vouchers (
  code       TEXT PRIMARY KEY,
  offer_id   TEXT NOT NULL,
  holder     TEXT NOT NULL,
  points     INTEGER NOT NULL,
  at         INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Nokor Point policy (Ministry of Tourism). Points per US dollar paid, and per
-- site entry. Riel payments count at 4,000 riel to the dollar.
INSERT INTO settings (key, value) VALUES
  ('points_per_usd', '10'),
  ('points_per_entry', '50'),
  ('khr_per_usd', '4000');

INSERT INTO offers (id, title, points, provider, description, baseline) VALUES
  ('baseline-site-discount', '$5 off any site access product', 500, 'Ministry of Tourism',
   'The state''s guaranteed baseline use of Nokor Point.', 1);
