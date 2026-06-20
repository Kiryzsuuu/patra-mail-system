"""
qr_engine.py — QR Code Generator dengan Perlindungan Anti-Copy
Resolusi tinggi untuk hasil cetak yang tajam
"""

import io
import qrcode
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers import RoundedModuleDrawer
from qrcode.image.styles.colormasks import SolidFillColorMask
from PIL import Image, ImageDraw, ImageFont
from typing import Optional


def generate_validation_qr(
    qr_token: str,
    base_url: str,
    doc_id: str,
    signer_name: str,
    signed_at_iso: str,
    output_size: tuple = (600, 600),
    include_label: bool = True,
    logo_path: Optional[str] = None
) -> bytes:
    """Generate QR code resolusi tinggi untuk hasil cetak tajam."""
    
    validation_url = f"{base_url}/{qr_token}?doc={doc_id}"
    
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=12,
        border=3,
    )
    qr.add_data(validation_url)
    qr.make(fit=True)
    
    qr_img = qr.make_image(
        image_factory=StyledPilImage,
        module_drawer=RoundedModuleDrawer(),
        color_mask=SolidFillColorMask(
            front_color=(15, 23, 42),
            back_color=(255, 255, 255)
        )
    ).convert("RGBA")
    
    if include_label:
        canvas = _add_label_box(qr_img, signer_name, signed_at_iso)
    else:
        canvas = qr_img
    
    canvas = canvas.resize(output_size, Image.LANCZOS)
    
    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True, dpi=(300, 300))
    buf.seek(0)
    return buf.read()


def _add_label_box(qr_img: Image.Image, signer_name: str, signed_at_iso: str) -> Image.Image:
    qr_w, qr_h = qr_img.size
    label_h = 60
    
    canvas = Image.new("RGBA", (qr_w, qr_h + label_h), (255, 255, 255, 255))
    canvas.paste(qr_img, (0, 0))
    
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([(0, qr_h), (qr_w, qr_h + label_h)], fill=(15, 23, 42))
    
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
        font_small = font
    
    name_short = signer_name[:24] + "..." if len(signer_name) > 24 else signer_name
    date_str = signed_at_iso[:10] if signed_at_iso else ""
    
    draw.text((12, qr_h + 8), f"✓ {name_short}", fill=(255, 255, 255), font=font)
    draw.text((12, qr_h + 34), date_str, fill=(148, 163, 184), font=font_small)
    
    return canvas


def generate_signature_visual(
    signer_name: str,
    signed_at_iso: str,
    doc_id_short: str,
    width: int = 900,
    height: int = 240
) -> bytes:
    """Generate visual tanda tangan resolusi tinggi."""
    
    img = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    
    # Border rounded
    draw.rounded_rectangle([(0, 0), (width-1, height-1)], radius=16, outline=(15, 23, 42), width=4)
    
    # Garis dekoratif kiri biru maroon
    draw.rectangle([(8, 10), (18, height-10)], fill=(107, 26, 26))
    
    try:
        font_label = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        font_name  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 38)
        font_info  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
    except Exception:
        font_label = font_name = font_info = font_small = ImageFont.load_default()
    
    draw.text((32, 20),  "Ditandatangani oleh:", fill=(100, 116, 139), font=font_label)
    draw.text((32, 50),  signer_name,            fill=(15, 23, 42),    font=font_name)
    draw.text((32, 102), f"Tanggal : {signed_at_iso[:10]}", fill=(71, 85, 105), font=font_info)
    draw.text((32, 136), f"Dok ID  : {doc_id_short.upper()}", fill=(71, 85, 105), font=font_info)
    draw.text((32, 170), "Verified via InARSign QR Code", fill=(107, 26, 26), font=font_small)
    draw.text((32, 196), "inarlabs.net", fill=(148, 163, 184), font=font_small)
    
    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(300, 300))
    buf.seek(0)
    return buf.read()
