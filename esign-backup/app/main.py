"""
main.py — FastAPI Application Entry Point
E-Sign System — by & for the owner only
"""

import os
import uuid
import json
import shutil
import base64
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Annotated

from fastapi import (
    FastAPI, UploadFile, File, Form, HTTPException,
    Depends, Request, Response, status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from dotenv import load_dotenv

load_dotenv()

from .database import (
    create_db_engine, get_session_factory,
    Base, User, Document, Signature, ValidationLog, AuditTrail, SignProfile
)
from .signer import (
    hash_pdf_bytes, hash_pdf_file,
    create_signature_payload, verify_signature_hmac,
    generate_qr_token, verify_qr_fingerprint,
    verify_document_integrity, generate_cosign_token, verify_cosign_token
)
from .qr_engine import generate_validation_qr, generate_signature_visual
from .pdf_stamper import stamp_signature_and_qr, get_pdf_page_info, pdf_to_preview_images

# ────────────────────────────────────────────────────────────
#  CONFIG
# ────────────────────────────────────────────────────────────

SECRET_KEY     = os.getenv("SECRET_KEY", "changeme")
HMAC_SECRET    = os.getenv("HMAC_SECRET", "changeme2")
QR_SALT        = os.getenv("QR_SALT", "changeme3")
BASE_URL       = os.getenv("BASE_URL", "http://localhost:8000")
QR_BASE_URL    = os.getenv("QR_BASE_URL", f"{BASE_URL}/verify")
DB_URL         = (
    f"mysql+pymysql://{os.getenv('DB_USER','root')}:{os.getenv('DB_PASSWORD','')}"
    f"@{os.getenv('DB_HOST','localhost')}:{os.getenv('DB_PORT','3306')}"
    f"/{os.getenv('DB_NAME','esign_db')}?charset=utf8mb4"
)

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./storage/uploads"))
SIGNED_DIR = Path(os.getenv("SIGNED_DIR", "./storage/signed"))
TEMP_DIR   = Path(os.getenv("TEMP_DIR", "./storage/temp"))
MAX_FILE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "50"))

for d in [UPLOAD_DIR, SIGNED_DIR, TEMP_DIR]:
    d.mkdir(parents=True, exist_ok=True)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = int(os.getenv("SESSION_EXPIRE_HOURS", "24"))
COSIGN_EXPIRE_HOURS = int(os.getenv("COSIGN_LINK_EXPIRE_HOURS", "72"))

# ────────────────────────────────────────────────────────────
#  APP SETUP
# ────────────────────────────────────────────────────────────

engine = create_db_engine(DB_URL)
SessionLocal = get_session_factory(engine)
Base.metadata.create_all(bind=engine)   # Auto-create tables

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

app = FastAPI(
    title="E-Sign System",
    version="1.0.0",
    docs_url=None,       # Sembunyikan docs di production
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", BASE_URL).split(","),
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory="frontend/templates")
app.mount("/static", StaticFiles(directory="frontend/static"), name="static")
app.mount("/storage/signed", StaticFiles(directory=str(SIGNED_DIR)), name="signed_files")


# ────────────────────────────────────────────────────────────
#  DEPENDENCIES
# ────────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_access_token(data: dict) -> str:
    expire = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    return jwt.encode({**data, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_owner(user: User = Depends(get_current_user)) -> User:
    if user.role != "owner":
        raise HTTPException(status_code=403, detail="Owner access required")
    return user


def log_audit(db: Session, action: str, doc_id: Optional[str] = None,
              user_id: Optional[str] = None, ip: Optional[str] = None, detail: dict = None):
    entry = AuditTrail(
        document_id=doc_id,
        user_id=user_id,
        action=action,
        detail=detail or {},
        ip_address=ip
    )
    db.add(entry)
    db.commit()


# ────────────────────────────────────────────────────────────
#  AUTH ENDPOINTS
# ────────────────────────────────────────────────────────────

@app.post("/api/auth/login")
async def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == username, User.is_active == True).first()
    if not user or not pwd_context.verify(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Username atau password salah")
    
    user.last_login = datetime.utcnow()
    db.commit()
    
    token = create_access_token({"sub": user.id, "role": user.role, "name": user.full_name})
    return {"access_token": token, "token_type": "bearer", "name": user.full_name, "role": user.role}


@app.get("/api/auth/me")
async def get_me(user: User = Depends(get_current_user)):
    return {"id": user.id, "name": user.full_name, "email": user.email, "role": user.role}


# ────────────────────────────────────────────────────────────
#  DOCUMENT ENDPOINTS
# ────────────────────────────────────────────────────────────

@app.post("/api/documents/upload")
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Upload PDF — hanya owner yang bisa."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Hanya file PDF yang diterima")
    
    content = await file.read()
    if len(content) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(400, f"File terlalu besar (max {MAX_FILE_MB}MB)")
    
    doc_hash = hash_pdf_bytes(content)
    
    # Cek duplikat - hanya tolak jika masih ada di database
    existing = db.query(Document).filter(
        Document.doc_hash == doc_hash,
        Document.owner_id == user.id
    ).first()
    if existing:
        # Kalau masih draft, kembalikan doc_id yang ada agar bisa dilanjutkan
        if existing.status == "draft":
            existing_path = UPLOAD_DIR / f"{existing.id}.pdf"
            page_info = get_pdf_page_info(str(existing_path)) if existing_path.exists() else []
            return {
                "doc_id": existing.id,
                "filename": existing.filename,
                "hash": doc_hash,
                "pages": page_info,
                "status": "draft",
                "note": "Dokumen sudah ada sebagai draft"
            }
        raise HTTPException(400, f"Dokumen ini sudah pernah di-upload (status: {existing.status}). Hapus dulu jika ingin upload ulang.")
    
    doc_id = str(uuid.uuid4())
    save_path = UPLOAD_DIR / f"{doc_id}.pdf"
    with open(save_path, "wb") as f:
        f.write(content)
    
    page_info = get_pdf_page_info(str(save_path))
    
    doc = Document(
        id=doc_id,
        doc_hash=doc_hash,
        filename=file.filename,
        owner_id=user.id,
        status="draft",
        metadata_={"pages": page_info, "original_filename": file.filename}
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    
    log_audit(db, "upload", doc_id, user.id, request.client.host if request.client else None,
              {"filename": file.filename, "size_bytes": len(content)})
    
    return {
        "doc_id": doc_id,
        "filename": file.filename,
        "hash": doc_hash,
        "pages": page_info,
        "status": "draft"
    }


@app.get("/api/documents")
async def list_documents(
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    docs = db.query(Document).filter(Document.owner_id == user.id).order_by(Document.created_at.desc()).all()
    return [
        {
            "doc_id": d.id,
            "filename": d.filename,
            "status": d.status,
            "allow_cosign": d.allow_cosign,
            "created_at": d.created_at.isoformat(),
            "signed_at": d.signed_at.isoformat() if d.signed_at else None,
            "signature_count": len(d.signatures)
        }
        for d in docs
    ]


@app.get("/api/documents/{doc_id}/preview/{page}")
async def get_page_preview(
    doc_id: str,
    page: int,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Kembalikan halaman PDF sebagai gambar untuk preview."""
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    
    pdf_path = str(UPLOAD_DIR / f"{doc_id}.pdf")
    if not Path(pdf_path).exists():
        # Coba dari signed dir
        pdf_path = str(SIGNED_DIR / f"{doc_id}.pdf")
    
    images = pdf_to_preview_images(pdf_path)
    if not images or page > len(images):
        raise HTTPException(404, "Halaman tidak ditemukan")
    
    img_bytes = images[page - 1]
    img_b64 = base64.b64encode(img_bytes).decode()
    return {"page": page, "image_b64": img_b64, "total_pages": len(images)}


# ────────────────────────────────────────────────────────────
#  SIGNING ENDPOINT
# ────────────────────────────────────────────────────────────

@app.post("/api/documents/{doc_id}/sign")
async def sign_document(
    request: Request,
    doc_id: str,
    page_number: int = Form(...),
    
    # Posisi signature block (% dari halaman)
    sig_x: float = Form(...),
    sig_y: float = Form(...),
    sig_w: float = Form(20.0),
    sig_h: float = Form(8.0),
    
    # Posisi QR code (% dari halaman)
    qr_x: float = Form(...),
    qr_y: float = Form(...),
    qr_size: float = Form(12.0),
    
    # Opsi
    lock_after: bool = Form(False),
    allow_cosign: bool = Form(False),
    show_sig_block: bool = Form(True),
    reason: str = Form(...),
    jabatan: str = Form(""),
    email_custom: str = Form(""),
    extra_pages: str = Form("[]"),
    
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """
    Tanda tangani dokumen — embed signature + QR ke PDF.
    """
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    if doc.status == "locked":
        raise HTTPException(400, "Dokumen sudah dikunci")
    
    upload_path = str(UPLOAD_DIR / f"{doc_id}.pdf")
    if not Path(upload_path).exists():
        raise HTTPException(404, "File PDF tidak ditemukan")
    
    doc_hash = hash_pdf_file(upload_path)
    
    # Buat payload & HMAC
    sig_data = create_signature_payload(
        doc_id=doc_id,
        doc_hash=doc_hash,
        signer_name=user.full_name,
        signer_email=user.email,
        page=page_number,
        pos_x=sig_x,
        pos_y=sig_y,
        base_url=BASE_URL,
        hmac_secret=HMAC_SECRET,
        extra={"signer_id": user.id, "reason": reason, "jabatan": jabatan, "email_display": email_custom or user.email}
    )
    
    # Generate QR token
    import time
    qr_token, qr_fingerprint = generate_qr_token(
        sig_id=sig_data["sig_id"],
        doc_id=doc_id,
        doc_hash=doc_hash,
        timestamp=int(time.time()),
        qr_salt=QR_SALT
    )
    
    # Generate visual gambar
    signed_at_iso = sig_data["payload"]["signed_at_iso"]
    sig_visual = generate_signature_visual(
        signer_name=user.full_name,
        signed_at_iso=signed_at_iso,
        doc_id_short=doc_id[:8].upper()
    )
    qr_visual = generate_validation_qr(
        qr_token=qr_token,
        base_url=QR_BASE_URL,
        doc_id=doc_id,
        signer_name=user.full_name,
        signed_at_iso=signed_at_iso
    )
    
    # Stamp ke PDF
    output_path = str(SIGNED_DIR / f"{doc_id}.pdf")
    stamp_result = stamp_signature_and_qr(
        input_pdf_path=upload_path,
        output_pdf_path=output_path,
        page_number=page_number - 1,
        sig_x_pct=sig_x, sig_y_pct=sig_y,
        sig_w_pct=sig_w, sig_h_pct=sig_h,
        signature_img_bytes=sig_visual if show_sig_block else None,
        qr_x_pct=qr_x, qr_y_pct=qr_y,
        qr_size_pct=qr_size,
        qr_img_bytes=qr_visual,
        lock_after_sign=lock_after,
        owner_password=SECRET_KEY[:32] if lock_after else None
    )
    
    # Hash file setelah di-sign
    signed_hash = hash_pdf_file(output_path)
    
    # Simpan ke database
    sig_record = Signature(
        id=sig_data["sig_id"],
        document_id=doc_id,
        signer_id=user.id,
        signer_name=user.full_name,
        signer_email=user.email,
        signature_type="owner",
        page_number=page_number,
        pos_x=sig_x, pos_y=sig_y,
        width=sig_w, height=sig_h,
        sig_hmac=sig_data["hmac"],
        sig_payload=sig_data["payload_canonical"],
        doc_hash_at_sign=doc_hash,
        qr_token=qr_token,
        qr_fingerprint=qr_fingerprint,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500]
    )
    db.add(sig_record)
    
    doc.metadata_ = {**(doc.metadata_ or {}), "last_reason": reason}
    # Handle extra pages - stamp signature on additional pages
    import json as json_module
    extra_page_list = json_module.loads(extra_pages) if extra_pages else []
    for extra_page in extra_page_list:
        extra_sig_data = create_signature_payload(
            doc_id=doc_id, doc_hash=doc_hash,
            signer_name=user.full_name, signer_email=user.email,
            page=extra_page, pos_x=sig_x, pos_y=sig_y,
            base_url=BASE_URL, hmac_secret=HMAC_SECRET,
            extra={"signer_id": user.id, "reason": reason, "jabatan": jabatan, "email_display": email_custom or user.email}
        )
        import time as time_module
        extra_qr_token, extra_qr_fp = generate_qr_token(
            sig_id=extra_sig_data["sig_id"], doc_id=doc_id,
            doc_hash=doc_hash, timestamp=int(time_module.time()), qr_salt=QR_SALT
        )
        extra_qr_visual = generate_validation_qr(
            extra_qr_token, QR_BASE_URL, doc_id,
            user.full_name, extra_sig_data["payload"]["signed_at_iso"]
        )
        extra_sig_visual = generate_signature_visual(
            user.full_name, extra_sig_data["payload"]["signed_at_iso"],
            doc_id[:8].upper()
        ) if show_sig_block else None

        temp_path = str(SIGNED_DIR / f"{doc_id}_temp.pdf")
        stamp_signature_and_qr(
            input_pdf_path=output_path, output_pdf_path=temp_path,
            page_number=extra_page - 1,
            sig_x_pct=sig_x, sig_y_pct=sig_y, sig_w_pct=sig_w, sig_h_pct=sig_h,
            signature_img_bytes=extra_sig_visual,
            qr_x_pct=qr_x, qr_y_pct=qr_y, qr_size_pct=qr_size,
            qr_img_bytes=extra_qr_visual,
        )
        import shutil as shutil_mod
        shutil_mod.move(temp_path, output_path)

        extra_sig_rec = Signature(
            id=extra_sig_data["sig_id"], document_id=doc_id,
            signer_id=user.id, signer_name=user.full_name,
            signer_email=user.email, signature_type="owner",
            page_number=extra_page,
            pos_x=sig_x, pos_y=sig_y, width=sig_w, height=sig_h,
            sig_hmac=extra_sig_data["hmac"],
            sig_payload=extra_sig_data["payload_canonical"],
            doc_hash_at_sign=doc_hash,
            qr_token=extra_qr_token, qr_fingerprint=extra_qr_fp,
            ip_address=request.client.host if request.client else None
        )
        db.add(extra_sig_rec)

    # Update signed hash after all pages
    signed_hash = hash_pdf_file(output_path)
    doc.signed_hash = signed_hash

    doc.status = "locked" if lock_after else ("cosign_open" if allow_cosign else "signed")
    doc.allow_cosign = allow_cosign
    doc.signed_at = datetime.utcnow()
    doc.signed_hash = signed_hash
    if lock_after:
        doc.locked_at = datetime.utcnow()
    
    db.commit()
    
    log_audit(db, "sign", doc_id, user.id, request.client.host if request.client else None,
              {"qr_token": qr_token, "locked": lock_after, "allow_cosign": allow_cosign})
    
    return {
        "success": True,
        "doc_id": doc_id,
        "sig_id": sig_data["sig_id"],
        "qr_token": qr_token,
        "signed_hash": signed_hash,
        "download_url": f"/api/documents/{doc_id}/download",
        "status": doc.status
    }


# ────────────────────────────────────────────────────────────
#  CO-SIGN
# ────────────────────────────────────────────────────────────

@app.post("/api/documents/{doc_id}/cosign-invite")
async def invite_cosigner(
    doc_id: str,
    email: str = Form(...),
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc or not doc.allow_cosign:
        raise HTTPException(400, "Dokumen tidak tersedia untuk co-sign")
    
    token = generate_cosign_token(doc_id, email, COSIGN_EXPIRE_HOURS, SECRET_KEY)
    cosign_url = f"{BASE_URL}/cosign?token={token}"
    
    return {
        "cosign_url": cosign_url,
        "expires_hours": COSIGN_EXPIRE_HOURS,
        "email": email,
        "note": "Kirimkan URL ini ke penandatangan. Link akan expired dalam 72 jam."
    }


@app.get("/api/documents/{doc_id}/download")
async def download_signed(
    doc_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    
    signed_path = SIGNED_DIR / f"{doc_id}.pdf"
    if not signed_path.exists():
        raise HTTPException(404, "File signed belum tersedia")
    
    return FileResponse(
        str(signed_path),
        media_type="application/pdf",
        filename=f"signed_{doc.filename}"
    )


# ────────────────────────────────────────────────────────────
#  VALIDATION (PUBLIC — untuk QR scan)
# ────────────────────────────────────────────────────────────

@app.get("/verify/{qr_token}", response_class=HTMLResponse)
async def validate_qr_page(
    request: Request,
    qr_token: str,
    doc: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Halaman validasi publik — dibuka saat scan QR."""
    client_ip = request.client.host if request.client else "unknown"
    result_data = _validate_qr(qr_token, doc, db)
    
    # Log validasi
    log = ValidationLog(
        qr_token=qr_token,
        document_id=result_data.get("doc_id"),
        result=result_data["status"],
        ip_address=client_ip,
        user_agent=request.headers.get("user-agent", "")[:500],
        details=result_data
    )
    db.add(log)
    db.commit()
    
    return templates.TemplateResponse("validate.html", {
        "request": request,
        "result": result_data,
        "qr_token": qr_token
    })


@app.get("/api/verify/{qr_token}")
async def validate_qr_api(
    qr_token: str,
    doc: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """API endpoint validasi — untuk integrasi."""
    return _validate_qr(qr_token, doc, db)


def _validate_qr(qr_token: str, doc_id_param: Optional[str], db: Session) -> dict:
    """Core validation logic."""
    sig = db.query(Signature).filter(Signature.qr_token == qr_token).first()
    
    if not sig:
        return {"status": "invalid", "message": "Token QR tidak ditemukan dalam sistem", "valid": False}
    
    doc = db.query(Document).filter(Document.id == sig.document_id).first()
    if not doc:
        return {"status": "invalid", "message": "Dokumen tidak ditemukan", "valid": False}
    
    # Cek doc_id di URL cocok dengan yang tersimpan
    if doc_id_param and doc_id_param != sig.document_id:
        return {
            "status": "tampered",
            "message": "QR code ini bukan milik dokumen yang diklaim. Kemungkinan copy-paste tidak valid.",
            "valid": False
        }
    
    # Verifikasi fingerprint (anti-copy)
    fp_valid = verify_qr_fingerprint(
        sig_id=sig.id,
        doc_hash=sig.doc_hash_at_sign,
        doc_id=sig.document_id,
        stored_fingerprint=sig.qr_fingerprint,
        qr_salt=QR_SALT
    )
    if not fp_valid:
        return {"status": "tampered", "message": "Fingerprint QR tidak valid", "valid": False}
    
    # Verifikasi HMAC signature
    hmac_valid = verify_signature_hmac(sig.sig_payload, sig.sig_hmac, HMAC_SECRET)
    if not hmac_valid:
        return {"status": "tampered", "message": "HMAC signature tidak valid — dokumen mungkin dimanipulasi", "valid": False}
    
    # Cek integritas file saat ini
    signed_path = str(SIGNED_DIR / f"{sig.document_id}.pdf")
    integrity = {"intact": True}
    if Path(signed_path).exists() and doc.signed_hash:
        integrity = verify_document_integrity(signed_path, doc.signed_hash)
    
    if not integrity["intact"]:
        return {
            "status": "tampered",
            "message": "File dokumen telah diubah setelah ditandatangani!",
            "valid": False
        }
    
    payload = json.loads(sig.sig_payload)
    reason = payload.get("reason", "")
    jabatan = payload.get("jabatan", "")
    email_display = payload.get("email_display", sig.signer_email or "")
    
    return {
        "status": "valid",
        "valid": True,
        "message": "Dokumen ini valid dan sah",
        "doc_id": sig.document_id,
        "filename": doc.filename,
        "signer_name": sig.signer_name,
        "signer_email": sig.signer_email,
        "signature_type": sig.signature_type,
        "signed_at": sig.signed_at.isoformat(),
        "page": sig.page_number,
        "doc_status": doc.status,
        "reason": reason,
        "jabatan": jabatan,
        "email_display": email_display,
        "all_signers": [
            {
                "name": s.signer_name,
                "type": s.signature_type,
                "signed_at": s.signed_at.isoformat(),
                "page": s.page_number
            }
            for s in doc.signatures
        ]
    }


# ────────────────────────────────────────────────────────────
#  PAGES
# ────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    return templates.TemplateResponse("dashboard.html", {"request": request})


@app.get("/cosign", response_class=HTMLResponse)
async def cosign_page(request: Request, token: str = ""):
    token_data = verify_cosign_token(token, SECRET_KEY) if token else None
    return templates.TemplateResponse("cosign.html", {
        "request": request,
        "token": token,
        "valid": token_data is not None,
        "doc_id": token_data["doc_id"] if token_data else None
    })


@app.delete("/api/documents/{doc_id}")
async def delete_document(
    doc_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Hapus dokumen (semua status)."""
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    
    import os
    # Hapus semua file terkait
    for folder in [UPLOAD_DIR, SIGNED_DIR, TEMP_DIR]:
        pdf_path = folder / f"{doc_id}.pdf"
        if pdf_path.exists():
            os.remove(str(pdf_path))
    
    db.delete(doc)
    db.commit()
    return {"success": True, "message": "Dokumen berhasil dihapus"}


@app.get("/api/documents/{doc_id}/raw")
async def get_raw_pdf(
    doc_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Serve raw PDF untuk preview di browser via PDF.js."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    pdf_path = UPLOAD_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        pdf_path = SIGNED_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "File tidak ditemukan")
    return FileResponse(str(pdf_path), media_type="application/pdf")


@app.get("/api/documents/{doc_id}/pageinfo")
async def get_page_info(
    doc_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Ambil info halaman PDF."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    pdf_path = UPLOAD_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        pdf_path = SIGNED_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "File tidak ditemukan")
    pages = get_pdf_page_info(str(pdf_path))
    return {"pages": pages, "total": len(pages)}


# ────────────────────────────────────────────────────────────
#  SIGN PROFILES
# ────────────────────────────────────────────────────────────

@app.get("/api/profiles")
async def list_profiles(
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """List semua profil penandatangan milik user."""
    profiles = db.query(SignProfile).filter(SignProfile.owner_id == user.id).order_by(SignProfile.created_at).all()
    return [
        {
            "id": p.id,
            "name": p.name,
            "display_name": p.display_name,
            "jabatan": p.jabatan,
            "email": p.email,
            "is_default": p.is_default,
            "created_at": p.created_at.isoformat()
        }
        for p in profiles
    ]

@app.post("/api/profiles")
async def create_profile(
    request: Request,
    name: str = Form(...),
    display_name: str = Form(...),
    jabatan: str = Form(""),
    email: str = Form(""),
    is_default: bool = Form(False),
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Buat profil penandatangan baru."""
    import uuid as uuid_mod
    if is_default:
        db.query(SignProfile).filter(SignProfile.owner_id == user.id).update({"is_default": False})
    
    profile = SignProfile(
        id=str(uuid_mod.uuid4()),
        owner_id=user.id,
        name=name,
        display_name=display_name,
        jabatan=jabatan,
        email=email or user.email,
        is_default=is_default
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return {"id": profile.id, "name": profile.name, "success": True}

@app.put("/api/profiles/{profile_id}")
async def update_profile(
    profile_id: str,
    name: str = Form(...),
    display_name: str = Form(...),
    jabatan: str = Form(""),
    email: str = Form(""),
    is_default: bool = Form(False),
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    profile = db.query(SignProfile).filter(SignProfile.id == profile_id, SignProfile.owner_id == user.id).first()
    if not profile:
        raise HTTPException(404, "Profil tidak ditemukan")
    if is_default:
        db.query(SignProfile).filter(SignProfile.owner_id == user.id).update({"is_default": False})
    profile.name = name
    profile.display_name = display_name
    profile.jabatan = jabatan
    profile.email = email or user.email
    profile.is_default = is_default
    db.commit()
    return {"success": True}

@app.delete("/api/profiles/{profile_id}")
async def delete_profile(
    profile_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    profile = db.query(SignProfile).filter(SignProfile.id == profile_id, SignProfile.owner_id == user.id).first()
    if not profile:
        raise HTTPException(404, "Profil tidak ditemukan")
    db.delete(profile)
    db.commit()
    return {"success": True}


# ────────────────────────────────────────────────────────────
#  COSIGN VIA LINK (24 jam)
# ────────────────────────────────────────────────────────────

@app.post("/api/documents/{doc_id}/cosign-link")
async def generate_cosign_link(
    doc_id: str,
    expire_hours: int = Form(24),
    sig_x: float = Form(5.0),
    sig_y: float = Form(75.0),
    sig_w: float = Form(30.0),
    sig_h: float = Form(8.0),
    qr_x: float = Form(75.0),
    qr_y: float = Form(72.0),
    qr_size: float = Form(15.0),
    show_sig_block: bool = Form(True),
    page_number: int = Form(1),
    extra_pages: str = Form("[]"),
    cosig_x: float = Form(5.0),
    cosig_y: float = Form(55.0),
    cosig_w: float = Form(30.0),
    cosig_h: float = Form(8.0),
    cosig_qr_x: float = Form(55.0),
    cosig_qr_y: float = Form(52.0),
    cosig_qr_size: float = Form(15.0),
    cosig_show_sig: bool = Form(True),
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Generate link co-sign — posisi sudah ditentukan main signer."""
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    if doc.status == "locked":
        raise HTTPException(400, "Dokumen dikunci, tidak bisa di-cosign")
    
    expire_hours = max(1, min(168, expire_hours))
    
    doc.allow_cosign = True
    if doc.status == "signed":
        doc.status = "cosign_open"
    db.commit()
    
    # Store position settings in doc metadata for cosigner to use
    import json as json_mod2
    cosign_settings = {
        "sig_x": cosig_x, "sig_y": cosig_y, "sig_w": cosig_w, "sig_h": cosig_h,
        "qr_x": cosig_qr_x, "qr_y": cosig_qr_y, "qr_size": cosig_qr_size,
        "show_sig_block": cosig_show_sig,
        "page_number": page_number,
        "extra_pages": json_mod2.loads(extra_pages) if extra_pages else []
    }
    import time as time_save
    token = generate_cosign_token(doc_id, "guest", expire_hours, SECRET_KEY)
    cosign_url = f"{BASE_URL}/cosign?token={token}&doc={doc_id}"
    expire_at = int(time_save.time()) + (expire_hours * 3600)
    
    doc.metadata_ = {
        **(doc.metadata_ or {}), 
        "cosign_settings": cosign_settings,
        "cosign_link": cosign_url,
        "cosign_expire_at": expire_at,
        "cosign_hours": expire_hours
    }
    db.commit()
    
    return {
        "cosign_url": cosign_url,
        "expires_hours": expire_hours,
        "expire_at": expire_at,
        "doc_id": doc_id
    }


@app.get("/api/cosign/validate")
async def validate_cosign_token_endpoint(
    token: str,
    doc: str,
    db: Session = Depends(get_db)
):
    """Validasi token cosign link."""
    token_data = verify_cosign_token(token, SECRET_KEY)
    if not token_data:
        return {"valid": False, "expired": True, "used": False}
    
    document = db.query(Document).filter(Document.id == doc).first()
    if not document:
        return {"valid": False, "expired": False, "used": False}
    
    # Check if token already used - match via token hash stored in user_id
    import hashlib as hl_check
    token_hash_check = hl_check.md5(token.encode()).hexdigest()[:16]
    used_log = db.query(AuditTrail).filter(
        AuditTrail.document_id == doc,
        AuditTrail.action == "cosign_token_used",
        AuditTrail.user_id == token_hash_check
    ).first()
    if used_log:
        return {"valid": False, "expired": False, "used": True}
    
    cosign_settings = (document.metadata_ or {}).get("cosign_settings", {})
    return {
        "valid": True,
        "expired": False,
        "used": False,
        "doc_id": doc,
        "filename": document.filename,
        "expire_at": token_data["expire_at"],
        "settings": cosign_settings
    }


@app.get("/api/cosign/pdf/{doc_id}")
async def get_cosign_pdf(
    doc_id: str,
    token: str,
    db: Session = Depends(get_db)
):
    """Serve PDF untuk cosigner tanpa login."""
    token_data = verify_cosign_token(token, SECRET_KEY)
    if not token_data:
        raise HTTPException(403, "Token tidak valid atau expired")
    
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    
    # Serve signed version if exists, else original
    pdf_path = SIGNED_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        pdf_path = UPLOAD_DIR / f"{doc_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "File tidak ditemukan")
    
    return FileResponse(str(pdf_path), media_type="application/pdf")


@app.post("/api/cosign/sign")
async def cosign_sign(
    request: Request,
    token: str = Form(...),
    doc_id: str = Form(...),
    signer_name: str = Form(...),
    signer_email: str = Form(...),
    jabatan: str = Form(""),
    reason: str = Form(...),
    page_number: int = Form(1),
    extra_pages: str = Form("[]"),
    db: Session = Depends(get_db)
):
    """Co-sign dokumen tanpa login — posisi dari setting main signer."""
    import json as json_mod, time as time_mod, shutil as shutil_mod, uuid as uuid_mod
    
    token_data = verify_cosign_token(token, SECRET_KEY)
    if not token_data:
        raise HTTPException(400, "Token tidak valid atau sudah expired")
    
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    if doc.status == "locked":
        raise HTTPException(400, "Dokumen sudah dikunci")
    
    # Base PDF
    base_path = str(SIGNED_DIR / f"{doc_id}.pdf")
    if not Path(base_path).exists():
        base_path = str(UPLOAD_DIR / f"{doc_id}.pdf")
    
    # Get position settings from doc metadata (set by main signer)
    import json as jmod
    settings = (doc.metadata_ or {}).get("cosign_settings", {})
    sig_x = settings.get("sig_x", 5.0)
    sig_y = settings.get("sig_y", 75.0)
    sig_w = settings.get("sig_w", 30.0)
    sig_h = settings.get("sig_h", 8.0)
    qr_x = settings.get("qr_x", 75.0)
    qr_y = settings.get("qr_y", 72.0)
    qr_size = settings.get("qr_size", 15.0)
    show_sig_block = settings.get("show_sig_block", True)
    page_number = settings.get("page_number", 1)
    extra_pages_list = settings.get("extra_pages", [])
    
    doc_hash = hash_pdf_file(base_path)
    
    # Cari atau buat guest user
    guest = db.query(User).filter(User.email == signer_email).first()
    if not guest:
        guest = User(
            id=str(uuid_mod.uuid4()), username=signer_email,
            email=signer_email, password_hash="",
            full_name=signer_name, role="cosigner"
        )
        db.add(guest)
        db.flush()
    
    # Process all pages
    all_pages = [page_number] + extra_pages_list
    output_path = base_path
    
    for page in all_pages:
        sig_data = create_signature_payload(
            doc_id=doc_id, doc_hash=doc_hash,
            signer_name=signer_name, signer_email=signer_email,
            page=page, pos_x=sig_x, pos_y=sig_y,
            base_url=BASE_URL, hmac_secret=HMAC_SECRET,
            extra={"cosigner": True, "reason": reason, "jabatan": jabatan, "email_display": signer_email}
        )
        qr_token, qr_fp = generate_qr_token(
            sig_id=sig_data["sig_id"], doc_id=doc_id,
            doc_hash=doc_hash, timestamp=int(time_mod.time()), qr_salt=QR_SALT
        )
        signed_at_iso = sig_data["payload"]["signed_at_iso"]
        sig_visual = generate_signature_visual(signer_name, signed_at_iso, doc_id[:8].upper()) if show_sig_block else None
        qr_visual = generate_validation_qr(qr_token, QR_BASE_URL, doc_id, signer_name, signed_at_iso)
        
        temp_path = str(TEMP_DIR / f"{doc_id}_cosign_{page}.pdf")
        stamp_signature_and_qr(
            input_pdf_path=output_path, output_pdf_path=temp_path,
            page_number=page - 1,
            sig_x_pct=sig_x, sig_y_pct=sig_y, sig_w_pct=sig_w, sig_h_pct=sig_h,
            signature_img_bytes=sig_visual,
            qr_x_pct=qr_x, qr_y_pct=qr_y, qr_size_pct=qr_size, qr_img_bytes=qr_visual,
        )
        final_path = str(SIGNED_DIR / f"{doc_id}.pdf")
        shutil_mod.move(temp_path, final_path)
        output_path = final_path
        
        sig_rec = Signature(
            id=sig_data["sig_id"], document_id=doc_id,
            signer_id=guest.id, signer_name=signer_name,
            signer_email=signer_email, signature_type="cosigner",
            page_number=page, pos_x=sig_x, pos_y=sig_y, width=sig_w, height=sig_h,
            sig_hmac=sig_data["hmac"], sig_payload=sig_data["payload_canonical"],
            doc_hash_at_sign=doc_hash, qr_token=qr_token, qr_fingerprint=qr_fp,
            ip_address=request.client.host if request.client else None
        )
        db.add(sig_rec)
    
    signed_hash = hash_pdf_file(output_path)
    doc.signed_hash = signed_hash
    doc.signed_at = doc.signed_at or datetime.utcnow()
    if doc.status in ["draft", "signed"]:
        doc.status = "cosign_open"
    
    # Mark token as used - store token hash in user_id for easy lookup
    import hashlib as hl2
    token_hash2 = hl2.md5(token.encode()).hexdigest()[:16]
    used_entry = AuditTrail(
        document_id=doc_id,
        user_id=token_hash2,
        action="cosign_token_used",
        detail={"signer": signer_name},
        ip_address=request.client.host if request.client else None
    )
    db.add(used_entry)
    db.commit()
    
    return {"success": True, "doc_id": doc_id}


@app.get("/api/documents/{doc_id}/cosign-link")
async def get_cosign_link(
    doc_id: str,
    user: User = Depends(require_owner),
    db: Session = Depends(get_db)
):
    """Ambil link co-sign yang sudah tersimpan."""
    doc = db.query(Document).filter(Document.id == doc_id, Document.owner_id == user.id).first()
    if not doc:
        raise HTTPException(404, "Dokumen tidak ditemukan")
    
    meta = doc.metadata_ or {}
    cosign_link = meta.get("cosign_link")
    expire_at = meta.get("cosign_expire_at", 0)
    
    import time as time_get
    if not cosign_link:
        return {"has_link": False}
    
    if int(time_get.time()) > expire_at:
        return {"has_link": False, "expired": True}
    
    return {
        "has_link": True,
        "cosign_url": cosign_link,
        "expire_at": expire_at,
        "hours_left": max(0, (expire_at - int(time_get.time())) // 3600)
    }
