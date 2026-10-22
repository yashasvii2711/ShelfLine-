-- Accounts and sessions

CREATE TABLE users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  email          VARCHAR(254) NOT NULL,
  password_hash  TEXT NOT NULL,
  role           VARCHAR(16) NOT NULL CHECK (role IN ('manager', 'staff')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email ON users (lower(email));

-- Only a SHA-256 hash of the session token is stored, so a database leak does not expose live sessions.
CREATE TABLE sessions (
  token_hash  CHAR(64) PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
