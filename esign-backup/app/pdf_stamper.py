"""
pdf_stamper.py — Menempelkan Tanda Tangan & QR Code ke PDF
Menggunakan pypdf + reportlab overlay technique
"""

import io
import tempfile
from pathlib import Path
from typing import Optional

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.units import mm
from reportlab.lib.pagesizes import A4
from PIL import Image as PILImage


def stamp_signature_and_qr(
    input_pdf_path: str,
    output_pdf_path: str,
    page_number: int,           # 0-indexed
    
    # Signature block position (% of page)
    sig_x_pct: float,
    sig_y_pct: float,
    sig_w_pct: float,
    sig_h_pct: float,
    signature_img_bytes: bytes,  # Visual signature image
    
    # QR Code position (% of page)
    qr_x_pct: float,
    qr_y_pct: float,
    qr_size_pct: float,
    qr_img_bytes: bytes,        # QR code image
    
    # Lock option
    lock_after_sign: bool = False,
    owner_password: Optional[str] = None,
) -> dict:
    """
    Tempelkan signature block + QR code ke halaman tertentu PDF.
    
    IMPORTANT: Koordinat dalam % (0.0 - 100.0) dari ukuran halaman.
    Ini memastikan posisi tepat di semua ukuran kertas.
    
    Returns dict dengan info hasil stamping.
    """
    reader = PdfReader(input_pdf_path)
    writer = PdfWriter()
    
    target_page = reader.pages[page_number]
    page_width = float(target_page.mediabox.width)   # dalam points (1pt = 1/72 inch)
    page_height = float(target_page.mediabox.height)
    
    # Konversi % ke points
    sig_x = (sig_x_pct / 100.0) * page_width
    sig_y = (sig_y_pct / 100.0) * page_height
    sig_w = (sig_w_pct / 100.0) * page_width
    sig_h = (sig_h_pct / 100.0) * page_height
    
    qr_x = (qr_x_pct / 100.0) * page_width
    qr_y = (qr_y_pct / 100.0) * page_height
    qr_size = (qr_size_pct / 100.0) * min(page_width, page_height)
    
    # Buat overlay PDF menggunakan reportlab
    overlay_buffer = io.BytesIO()
    c = rl_canvas.Canvas(overlay_buffer, pagesize=(page_width, page_height))
    
    # --- Gambar Signature Block (opsional) ---
    if signature_img_bytes is not None:
        sig_img_buf = io.BytesIO(signature_img_bytes)
        sig_pil = PILImage.open(sig_img_buf).convert("RGB")
        sig_y_rl = page_height - sig_y - sig_h
        c.drawInlineImage(sig_pil, sig_x, sig_y_rl, width=sig_w, height=sig_h)
    
    # --- Gambar QR Code ---
    qr_img_buf = io.BytesIO(qr_img_bytes)
    qr_pil = PILImage.open(qr_img_buf).convert("RGB")
    qr_y_rl = page_height - qr_y - qr_size
    c.drawInlineImage(qr_pil, qr_x, qr_y_rl, width=qr_size, height=qr_size)
    
    # Halaman kosong untuk halaman yang tidak di-stamp
    c.save()
    overlay_buffer.seek(0)
    
    # Merge overlay ke PDF asli
    overlay_reader = PdfReader(overlay_buffer)
    overlay_page = overlay_reader.pages[0]
    
    for i, page in enumerate(reader.pages):
        if i == page_number:
            page.merge_page(overlay_page)
        writer.add_page(page)
    
    # Copy metadata asli
    if reader.metadata:
        writer.add_metadata(reader.metadata)
    
    # Tambah metadata signature
    writer.add_metadata({
        "/Signed": "true",
        "/SignedAt": "esign-system",
    })
    
    # Lock jika diminta (encrypt dengan password)
    if lock_after_sign and owner_password:
        writer.encrypt(
            user_password="",            # User bisa buka tapi tidak bisa edit
            owner_password=owner_password,
            use_128bit=True,
            permissions_flag=4            # Read only
        )
    
    # Tulis output
    with open(output_pdf_path, "wb") as out:
        writer.write(out)
    
    return {
        "success": True,
        "output_path": output_pdf_path,
        "page": page_number + 1,
        "page_size": {"width": page_width, "height": page_height},
        "locked": lock_after_sign,
        "total_pages": len(reader.pages)
    }


def get_pdf_page_info(pdf_path: str) -> list[dict]:
    """
    Ambil info semua halaman PDF untuk keperluan preview.
    Returns list of {page, width, height, width_mm, height_mm}
    """
    reader = PdfReader(pdf_path)
    pages = []
    for i, page in enumerate(reader.pages):
        w = float(page.mediabox.width)
        h = float(page.mediabox.height)
        pages.append({
            "page": i + 1,
            "width_pt": w,
            "height_pt": h,
            "width_mm": round(w * 0.352778, 1),
            "height_mm": round(h * 0.352778, 1),
        })
    return pages


def pdf_to_preview_images(pdf_path: str, dpi: int = 96) -> list[bytes]:
    """
    Convert PDF halaman ke gambar PNG untuk preview di browser.
    Menggunakan pdf2image (poppler). Install: apt install poppler-utils
    """
    try:
        from pdf2image import convert_from_path
        images = convert_from_path(pdf_path, dpi=dpi)
        result = []
        for img in images:
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            buf.seek(0)
            result.append(buf.read())
        return result
    except ImportError:
        # Fallback: return placeholder jika pdf2image tidak ada
        return []
