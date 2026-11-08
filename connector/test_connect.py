"""Tests for the local consent connector (no browser, no network)."""
import base64
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load():
    spec = importlib.util.spec_from_file_location("rozlf_connect", ROOT / "rozlf_connect.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rozlf_connect"] = module
    spec.loader.exec_module(module)
    return module


connector = load()


def decrypt_with_cryptography(code: str, blob: dict) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aes = AESGCM(connector.derive_key(code))
    sealed = base64.b64decode(blob["ct"]) + base64.b64decode(blob["tag"])
    return aes.decrypt(base64.b64decode(blob["iv"]), sealed, b"rozlf-connect").decode()


def test_payload_is_encrypted_and_decrypts():
    blob = connector.encrypt_payload("ABCD-2345", "session-token-xyz")
    assert sorted(blob) == ["ct", "iv", "kdf", "tag", "v"]
    assert "session-token-xyz" not in json.dumps(blob)
    assert decrypt_with_cryptography("ABCD-2345", blob) == "session-token-xyz"


def test_wrong_code_cannot_decrypt():
    from cryptography.exceptions import InvalidTag

    blob = connector.encrypt_payload("ABCD-2345", "session-token-xyz")
    try:
        decrypt_with_cryptography("ZZZZ-9999", blob)
    except InvalidTag:
        return
    raise AssertionError("wrong pairing code must not decrypt")


def test_extract_token_prefers_the_token_cookie():
    assert connector.extract_token("a=1; token=abc%2Bdef; b=2", {}) == "abc+def"
    assert connector.extract_token("", {"auth_user": json.dumps({"token": "from-store"})}) == "from-store"
    assert connector.extract_token("", {"plain": "x" * 40}) == ""
    assert connector.extract_token("", {}) == ""


def test_mask_never_prints_the_full_token():
    masked = connector.mask("abcdefghijklmnop")
    assert "abcdefghijklmnop" not in masked
    assert masked.startswith("abcd")
    assert connector.mask("short") == "*****"
