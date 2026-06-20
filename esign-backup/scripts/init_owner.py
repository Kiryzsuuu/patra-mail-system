import sys
import os
import uuid
import getpass
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from passlib.context import CryptContext
from app.database import create_db_engine, get_session_factory, Base, User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def init():
    print("\n=== Inisialisasi Akun Owner E-Sign System ===\n")

    db_user = os.getenv('DB_USER', 'root')
    db_pass = os.getenv('DB_PASSWORD', '')
    db_host = os.getenv('DB_HOST', 'localhost')
    db_port = os.getenv('DB_PORT', '3306')
    db_name = os.getenv('DB_NAME', 'esign_db')
    DB_URL = "mysql+pymysql://" + db_user + ":" + db_pass + "@" + db_host + ":" + db_port + "/" + db_name + "?charset=utf8mb4"

    engine = create_db_engine(DB_URL)
    Base.metadata.create_all(bind=engine)
    SessionLocal = get_session_factory(engine)
    db = SessionLocal()

    existing = db.query(User).filter(User.role == "owner").first()
    if existing:
        print("Owner sudah ada: " + existing.full_name + " (" + existing.email + ")")
        db.close()
        return

    print("Buat akun owner pertama:\n")
    full_name = os.getenv("OWNER_NAME") or input("Nama lengkap: ").strip()
    email = os.getenv("OWNER_EMAIL") or input("Email: ").strip()
    username = input("Username (untuk login): ").strip()

    while True:
        pw = getpass.getpass("Password (min 8 karakter): ")
        if len(pw) < 8:
            print("Password terlalu pendek!")
            continue
        confirm = getpass.getpass("Konfirmasi password: ")
        if pw != confirm:
            print("Password tidak cocok!")
            continue
        break

    new_user = User(
        id=str(uuid.uuid4()),
        username=username,
        email=email,
        password_hash=pwd_context.hash(pw),
        full_name=full_name,
        role="owner",
        is_active=True
    )
    db.add(new_user)
    db.commit()

    print("\nAkun owner berhasil dibuat!")
    print("  Nama    : " + full_name)
    print("  Username: " + username)
    db.close()

if __name__ == "__main__":
    init()
