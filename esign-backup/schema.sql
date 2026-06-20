-- ============================================================
--  E-SIGN SYSTEM - Database Schema
--  Compatible: MySQL 5.7+ / MariaDB 10.3+
-- ============================================================

CREATE DATABASE IF NOT EXISTS esign_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE esign_db;

-- --------------------------------------------------------
-- Table: documents
-- Menyimpan setiap dokumen yang di-upload & di-sign
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
    id            VARCHAR(36)     NOT NULL PRIMARY KEY,   -- UUID v4
    doc_hash      VARCHAR(64)     NOT NULL UNIQUE,        -- SHA-256 dari file ASLI (sebelum sign)
    signed_hash   VARCHAR(64)     DEFAULT NULL,           -- SHA-256 dari file SETELAH sign
    filename      VARCHAR(255)    NOT NULL,
    owner_id      VARCHAR(36)     NOT NULL,               -- FK ke users
    status        ENUM('draft','signed','locked','cosign_open') NOT NULL DEFAULT 'draft',
    allow_cosign  TINYINT(1)      NOT NULL DEFAULT 0,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signed_at     DATETIME        DEFAULT NULL,
    locked_at     DATETIME        DEFAULT NULL,
    metadata      JSON            DEFAULT NULL,           -- Data tambahan (halaman, posisi, dll)
    INDEX idx_owner (owner_id),
    INDEX idx_status (status),
    INDEX idx_doc_hash (doc_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: signatures
-- Setiap tanda tangan yang tertempel di dokumen
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS signatures (
    id            VARCHAR(36)     NOT NULL PRIMARY KEY,
    document_id   VARCHAR(36)     NOT NULL,
    signer_id     VARCHAR(36)     NOT NULL,               -- FK ke users
    signer_name   VARCHAR(255)    NOT NULL,
    signer_email  VARCHAR(255)    DEFAULT NULL,
    signature_type ENUM('owner','cosigner') NOT NULL DEFAULT 'owner',

    -- Posisi di halaman PDF
    page_number   INT             NOT NULL DEFAULT 1,
    pos_x         FLOAT           NOT NULL,               -- % dari lebar halaman
    pos_y         FLOAT           NOT NULL,               -- % dari tinggi halaman
    width         FLOAT           NOT NULL DEFAULT 20.0,  -- % lebar
    height        FLOAT           NOT NULL DEFAULT 8.0,   -- % tinggi

    -- Kriptografi
    sig_hmac      VARCHAR(128)    NOT NULL,               -- HMAC-SHA256
    sig_payload   TEXT            NOT NULL,               -- JSON payload yang di-sign
    doc_hash_at_sign VARCHAR(64)  NOT NULL,               -- Hash dokumen saat tanda tangan dibuat

    -- QR Code
    qr_token      VARCHAR(128)    NOT NULL UNIQUE,        -- Token unik untuk QR
    qr_fingerprint VARCHAR(64)    NOT NULL,               -- Fingerprint anti-copy

    signed_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address    VARCHAR(45)     DEFAULT NULL,
    user_agent    VARCHAR(500)    DEFAULT NULL,

    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    INDEX idx_document (document_id),
    INDEX idx_qr_token (qr_token),
    INDEX idx_signer (signer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: users
-- Hanya Anda sebagai owner, cosigner bisa guest
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36)     NOT NULL PRIMARY KEY,
    username      VARCHAR(100)    NOT NULL UNIQUE,
    email         VARCHAR(255)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)    NOT NULL,               -- bcrypt
    full_name     VARCHAR(255)    NOT NULL,
    role          ENUM('owner','cosigner') NOT NULL DEFAULT 'cosigner',
    is_active     TINYINT(1)      NOT NULL DEFAULT 1,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login    DATETIME        DEFAULT NULL,
    api_key_hash  VARCHAR(255)    DEFAULT NULL,           -- Untuk API access
    INDEX idx_email (email),
    INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: validation_logs
-- Log setiap kali QR di-scan / validasi
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS validation_logs (
    id            BIGINT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    qr_token      VARCHAR(128)    NOT NULL,
    document_id   VARCHAR(36)     DEFAULT NULL,
    result        ENUM('valid','invalid','tampered','expired') NOT NULL,
    ip_address    VARCHAR(45)     DEFAULT NULL,
    user_agent    VARCHAR(500)    DEFAULT NULL,
    checked_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    details       JSON            DEFAULT NULL,
    INDEX idx_qr_token (qr_token),
    INDEX idx_checked_at (checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- Table: audit_trail
-- Riwayat lengkap semua aksi (immutable log)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_trail (
    id            BIGINT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    document_id   VARCHAR(36)     DEFAULT NULL,
    user_id       VARCHAR(36)     DEFAULT NULL,
    action        VARCHAR(100)    NOT NULL,               -- upload, sign, lock, validate, etc.
    detail        JSON            DEFAULT NULL,
    ip_address    VARCHAR(45)     DEFAULT NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_document (document_id),
    INDEX idx_action (action),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
