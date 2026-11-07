import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken

from . import config


def _fernet() -> Fernet:
    key = config.SECRET_KEY or "rozzlf-local-dev-secret"
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def mask_account(login: str) -> str:
    if not login:
        return ""
    if len(login) <= 4:
        return login[0] + "*" * (len(login) - 1)
    return login[:2] + "*" * (len(login) - 4) + login[-2:]


def dashboard_token_ok(supplied: str | None) -> bool:
    expected = config.DASHBOARD_TOKEN
    if not expected:
        return True
    if not supplied:
        return False
    return hmac.compare_digest(supplied, expected)
