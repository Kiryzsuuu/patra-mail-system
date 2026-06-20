"""
database.py — SQLAlchemy Models & Connection Pool
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    create_engine, Column, String, Integer, Float,
    DateTime, Text, JSON, Enum, Boolean, BigInteger,
    ForeignKey, Index
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from sqlalchemy.pool import QueuePool

Base = declarative_base()


# ────────────────────────────────────────────────────────────
#  MODELS
# ────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"
    
    id           = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username     = Column(String(100), nullable=False, unique=True)
    email        = Column(String(255), nullable=False, unique=True)
    password_hash = Column(String(255), nullable=False)
    full_name    = Column(String(255), nullable=False)
    role         = Column(Enum("owner", "cosigner"), nullable=False, default="cosigner")
    is_active    = Column(Boolean, nullable=False, default=True)
    created_at   = Column(DateTime, default=datetime.utcnow)
    last_login   = Column(DateTime, nullable=True)
    api_key_hash = Column(String(255), nullable=True)
    
    documents    = relationship("Document", back_populates="owner", foreign_keys="Document.owner_id")
    signatures   = relationship("Signature", back_populates="signer")


class Document(Base):
    __tablename__ = "documents"
    
    id           = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    doc_hash     = Column(String(64), nullable=False, unique=True)
    signed_hash  = Column(String(64), nullable=True)
    filename     = Column(String(255), nullable=False)
    owner_id     = Column(String(36), ForeignKey("users.id"), nullable=False)
    status       = Column(
        Enum("draft", "signed", "locked", "cosign_open"),
        nullable=False, default="draft"
    )
    allow_cosign = Column(Boolean, nullable=False, default=False)
    created_at   = Column(DateTime, default=datetime.utcnow)
    signed_at    = Column(DateTime, nullable=True)
    locked_at    = Column(DateTime, nullable=True)
    metadata_    = Column("metadata", JSON, nullable=True)
    
    owner        = relationship("User", back_populates="documents", foreign_keys=[owner_id])
    signatures   = relationship("Signature", back_populates="document", cascade="all, delete-orphan")
    audit_entries = relationship("AuditTrail", back_populates="document")


class Signature(Base):
    __tablename__ = "signatures"
    
    id               = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id      = Column(String(36), ForeignKey("documents.id"), nullable=False)
    signer_id        = Column(String(36), ForeignKey("users.id"), nullable=False)
    signer_name      = Column(String(255), nullable=False)
    signer_email     = Column(String(255), nullable=True)
    signature_type   = Column(Enum("owner", "cosigner"), nullable=False, default="owner")
    
    page_number      = Column(Integer, nullable=False, default=1)
    pos_x            = Column(Float, nullable=False)
    pos_y            = Column(Float, nullable=False)
    width            = Column(Float, nullable=False, default=20.0)
    height           = Column(Float, nullable=False, default=8.0)
    
    sig_hmac         = Column(String(128), nullable=False)
    sig_payload      = Column(Text, nullable=False)
    doc_hash_at_sign = Column(String(64), nullable=False)
    
    qr_token         = Column(String(128), nullable=False, unique=True)
    qr_fingerprint   = Column(String(64), nullable=False)
    
    signed_at        = Column(DateTime, default=datetime.utcnow)
    ip_address       = Column(String(45), nullable=True)
    user_agent       = Column(String(500), nullable=True)
    
    document         = relationship("Document", back_populates="signatures")
    signer           = relationship("User", back_populates="signatures")
    
    __table_args__ = (
        Index("idx_qr_token", "qr_token"),
        Index("idx_document_id", "document_id"),
    )


class ValidationLog(Base):
    __tablename__ = "validation_logs"
    
    id          = Column(BigInteger, primary_key=True, autoincrement=True)
    qr_token    = Column(String(128), nullable=False)
    document_id = Column(String(36), nullable=True)
    result      = Column(Enum("valid", "invalid", "tampered", "expired"), nullable=False)
    ip_address  = Column(String(45), nullable=True)
    user_agent  = Column(String(500), nullable=True)
    checked_at  = Column(DateTime, default=datetime.utcnow)
    details     = Column(JSON, nullable=True)
    
    __table_args__ = (
        Index("idx_vlog_token", "qr_token"),
        Index("idx_vlog_checked", "checked_at"),
    )


class AuditTrail(Base):
    __tablename__ = "audit_trail"
    
    id          = Column(BigInteger, primary_key=True, autoincrement=True)
    document_id = Column(String(36), ForeignKey("documents.id"), nullable=True)
    user_id     = Column(String(36), nullable=True)
    action      = Column(String(100), nullable=False)
    detail      = Column(JSON, nullable=True)
    ip_address  = Column(String(45), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)
    
    document    = relationship("Document", back_populates="audit_entries")
    
    __table_args__ = (
        Index("idx_audit_doc", "document_id"),
        Index("idx_audit_action", "action"),
    )


# ────────────────────────────────────────────────────────────
#  ENGINE & SESSION
# ────────────────────────────────────────────────────────────

def create_db_engine(db_url: str, pool_size: int = 10, max_overflow: int = 20):
    return create_engine(
        db_url,
        poolclass=QueuePool,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=True,       # Auto-reconnect jika koneksi putus
        pool_recycle=3600,        # Recycle koneksi tiap 1 jam
        echo=False,               # Set True untuk debug SQL
    )


def get_session_factory(engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


class SignProfile(Base):
    __tablename__ = "sign_profiles"
    
    id           = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id     = Column(String(36), ForeignKey("users.id"), nullable=False)
    name         = Column(String(100), nullable=False)
    display_name = Column(String(255), nullable=False)
    jabatan      = Column(String(255), nullable=True)
    email        = Column(String(255), nullable=True)
    is_default   = Column(Boolean, nullable=False, default=False)
    created_at   = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (
        Index("idx_profile_owner", "owner_id"),
    )
