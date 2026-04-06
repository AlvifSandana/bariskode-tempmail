-- Temp Email Database Schema
-- Version: 1.0.0
-- Compatible with Cloudflare D1 (SQLite)

-- ============================================
-- EMAIL ADDRESSES
-- ============================================
CREATE TABLE IF NOT EXISTS address (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,           -- full email address (e.g. tmp_abc123@domain.com)
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    password    TEXT,                           -- bcrypt hash of address password (optional)
    source_ip   TEXT,                           -- IP address that created this address
    balance     INTEGER DEFAULT 0               -- for future credit system
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);
CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

-- ============================================
-- INCOMING MAILS
-- ============================================
CREATE TABLE IF NOT EXISTS mails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT,                           -- raw source IP of sender
    address     TEXT NOT NULL,                  -- recipient address (matches address.name)
    raw         TEXT,                           -- raw email content (may be NULL if stripped)
    subject     TEXT,
    sender      TEXT,                           -- parsed sender email
    message_id  TEXT,                           -- email Message-ID header
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_read     INTEGER DEFAULT 0,
    metadata    TEXT                            -- JSON: { ai_extraction, has_attachment, etc. }
);

CREATE INDEX IF NOT EXISTS idx_mails_address ON mails(address);
CREATE INDEX IF NOT EXISTS idx_mails_message_id ON mails(message_id);
CREATE INDEX IF NOT EXISTS idx_mails_created_at ON mails(created_at);

-- ============================================
-- SENT MAILS (SENDBOX)
-- ============================================
CREATE TABLE IF NOT EXISTS sendbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    address     TEXT NOT NULL,                  -- sender address
    raw         TEXT,                           -- raw email content
    subject     TEXT,
    sender      TEXT,                           -- display sender
    recipient   TEXT NOT NULL,                  -- recipient email
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);
CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

-- ============================================
-- USER ACCOUNTS
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email  TEXT UNIQUE,                    -- login email (not temp email)
    password    TEXT,                           -- bcrypt hash
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(user_email);

-- ============================================
-- USER <-> ADDRESS BINDING
-- ============================================
CREATE TABLE IF NOT EXISTS user_address (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    address_id  INTEGER NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES address(id) ON DELETE CASCADE,
    UNIQUE(user_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_user_address_user ON user_address(user_id);
CREATE INDEX IF NOT EXISTS idx_user_address_address ON user_address(address_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_address_unique_address ON user_address(address_id);

-- ============================================
-- USER ROLES
-- ============================================
CREATE TABLE IF NOT EXISTS user_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    role_text   TEXT NOT NULL,                  -- role name: 'default', 'vip', 'admin', etc.
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);

-- ============================================
-- SETTINGS (Key-Value Store)
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT
);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES 
    ('announcement', ''),
    ('spam_list', '[]'),
    ('blacklist', '[]'),
    ('whitelist', '[]'),
    ('default_domains', '[]'),
    ('user_roles_config', '[]'),
    ('ai_extract_settings', '{"enabled":false,"address_whitelist":[]}'),
    ('address_name_blacklist', '[]'),
    ('ip_blacklist', '[]'),
    ('cleanup_rules', '{"max_age_days":7,"cleanup_empty":true,"cleanup_unbound":true}'),
    ('custom_sql_cleanup', '');

-- ============================================
-- ATTACHMENTS METADATA
-- ============================================
CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mail_id         INTEGER NOT NULL,
    address         TEXT NOT NULL,
    filename        TEXT,
    storage_key     TEXT,                       -- R2/S3 object key
    size            INTEGER,                    -- bytes
    content_type    TEXT,
    content_id      TEXT,                       -- for inline images
    is_inline       INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mail_id) REFERENCES mails(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_mail ON attachments(mail_id);
CREATE INDEX IF NOT EXISTS idx_attachments_address ON attachments(address);

-- ============================================
-- WEBAUTHN CREDENTIALS (for Passkey)
-- ============================================
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    credential_id   TEXT NOT NULL UNIQUE,
    public_key      TEXT NOT NULL,
    counter         INTEGER DEFAULT 0,
    transports      TEXT,                       -- JSON array
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- ============================================
-- OAUTH CONNECTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS oauth_connections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    provider        TEXT NOT NULL,              -- 'github', 'authentik', etc.
    provider_id     TEXT NOT NULL,              -- provider's user ID
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(provider, provider_id)
);
