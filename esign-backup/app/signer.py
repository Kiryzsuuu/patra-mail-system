"""
signer.py — Engine Kriptografi E-Sign
Handles: PDF hashing, HMAC signing, QR fingerprint, verification
"""

import hashlib
import hmac
import json
import time
import uuid
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend


# ────────────────────────────────────────────────────────────
#  1. PDF HASHING
# ────────────────────────────────────────────────────────────

def hash_pdf_file(file_path: str) -> str:
    """
    Hitung SHA-256 dari file PDF.
    Hash ini menjadi 'sidik jari' dokumen — jika 1 byte berubah, hash berbeda.
    """
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def hash_pdf_bytes(data: bytes) -> str:
    """Hash dari bytes langsung (untuk file yang baru di-upload)."""
    return hashlib.sha256(data).hexdigest()


# ────────────────────────────────────────────────────────────
#  2. HMAC SIGNATURE
# ────────────────────────────────────────────────────────────

def create_signature_payload(
    doc_id: str,
    doc_hash: str,
    signer_name: str,
    signer_email: str,
    page: int,
    pos_x: float,
    pos_y: float,
    base_url: str,
    hmac_secret: str,
    extra: Optional[dict] = None
) -> dict:
    """
    Buat payload lengkap untuk satu tanda tangan.
    Payload ini yang akan di-HMAC dan disimpan di database.
    """
    sig_id = str(uuid.uuid4())
    timestamp = int(time.time())
    
    payload = {
        "sig_id": sig_id,
        "doc_id": doc_id,
        "doc_hash": doc_hash,           # Hash PDF saat ditandatangani
        "signer_name": signer_name,
        "signer_email": signer_email,
        "page": page,
        "pos_x": round(pos_x, 4),
        "pos_y": round(pos_y, 4),
        "timestamp": timestamp,
        "signed_at_iso": datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(),
        "base_url": base_url,
    }
    
    if extra:
        payload.update(extra)
    
    # Buat HMAC dari payload (deterministic: sorted keys)
    payload_canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    sig_hmac = hmac.new(
        hmac_secret.encode('utf-8'),
        payload_canonical.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    return {
        "sig_id": sig_id,
        "payload": payload,
        "payload_canonical": payload_canonical,
        "hmac": sig_hmac,
    }


def verify_signature_hmac(payload_canonical: str, stored_hmac: str, hmac_secret: str) -> bool:
    """
    Verifikasi HMAC signature.
    Menggunakan hmac.compare_digest untuk mencegah timing attack.
    """
    expected = hmac.new(
        hmac_secret.encode('utf-8'),
        payload_canonical.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, stored_hmac)


# ────────────────────────────────────────────────────────────
#  3. QR TOKEN ANTI-COPY
# ────────────────────────────────────────────────────────────

def generate_qr_token(
    sig_id: str,
    doc_id: str,
    doc_hash: str,
    timestamp: int,
    qr_salt: str
) -> tuple[str, str]:
    """
    Generate QR token + fingerprint.
    
    ANTI-COPY MECHANISM:
    - Token mengandung hash dari (sig_id + doc_id + doc_hash + timestamp + salt)
    - Jika QR di-crop dan ditempel ke PDF lain:
      → doc_hash akan berbeda dari yang ada di database
      → Validasi GAGAL
    - Token ini UNIK per (signature × dokumen) — tidak bisa dipindah
    
    Returns: (qr_token, qr_fingerprint)
    """
    # Token = identifikasi unik
    raw_token = f"{sig_id}:{doc_id}:{timestamp}"
    token_bytes = raw_token.encode('utf-8')
    token_hash = hashlib.sha256(token_bytes + qr_salt.encode('utf-8')).hexdigest()[:32]
    qr_token = f"{sig_id[:8]}-{token_hash}"
    
    # Fingerprint = terikat ke konten dokumen
    fp_raw = f"{sig_id}:{doc_hash}:{doc_id}:{qr_salt}"
    qr_fingerprint = hashlib.sha256(fp_raw.encode('utf-8')).hexdigest()
    
    return qr_token, qr_fingerprint


def verify_qr_fingerprint(
    sig_id: str,
    doc_hash: str,
    doc_id: str,
    stored_fingerprint: str,
    qr_salt: str
) -> bool:
    """
    Verifikasi bahwa QR code memang milik dokumen ini.
    Dipanggil saat validasi QR scan.
    """
    fp_raw = f"{sig_id}:{doc_hash}:{doc_id}:{qr_salt}"
    expected = hashlib.sha256(fp_raw.encode('utf-8')).hexdigest()
    return hmac.compare_digest(expected, stored_fingerprint)


# ────────────────────────────────────────────────────────────
#  4. COSIGN INVITE TOKEN
# ────────────────────────────────────────────────────────────

def generate_cosign_token(
    doc_id: str,
    invited_email: str,
    expire_hours: int,
    secret_key: str
) -> str:
    """
    Generate token undangan co-sign yang expire.
    """
    expire_at = int(time.time()) + (expire_hours * 3600)
    payload = f"{doc_id}:{invited_email}:{expire_at}"
    token_hmac = hmac.new(
        secret_key.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    raw = f"{payload}:{token_hmac}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def verify_cosign_token(token: str, secret_key: str) -> Optional[dict]:
    """
    Verifikasi token undangan co-sign.
    Returns dict dengan doc_id, email, expire_at jika valid, None jika tidak.
    """
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        parts = decoded.rsplit(':', 1)
        if len(parts) != 2:
            return None
        
        payload, stored_hmac = parts
        expected_hmac = hmac.new(
            secret_key.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(expected_hmac, stored_hmac):
            return None
        
        payload_parts = payload.split(':')
        if len(payload_parts) != 3:
            return None
        
        doc_id, email, expire_at = payload_parts
        
        if int(time.time()) > int(expire_at):
            return None
        
        return {
            "doc_id": doc_id,
            "email": email,
            "expire_at": int(expire_at)
        }
    except Exception:
        return None


# ────────────────────────────────────────────────────────────
#  5. DOCUMENT INTEGRITY CHECK
# ────────────────────────────────────────────────────────────

def verify_document_integrity(
    current_file_path: str,
    stored_signed_hash: str
) -> dict:
    """
    Cek apakah dokumen yang tersimpan tidak diubah sejak ditandatangani.
    """
    current_hash = hash_pdf_file(current_file_path)
    is_intact = hmac.compare_digest(current_hash, stored_signed_hash)
    
    return {
        "intact": is_intact,
        "current_hash": current_hash,
        "stored_hash": stored_signed_hash,
        "tampered": not is_intact
    }
