#!/usr/bin/env python3
"""ROZLF local consent connector.

Why this exists
---------------
A website cannot read another site's session (Safari and every other browser
enforce that isolation). So ROZLF never tries to. Instead this connector opens
its *own* browser window at https://m.expertoption.com; you sign in there
yourself, in a profile this program controls. It then reads the session token
that the ExpertOption page itself stored, encrypts it on your machine with the
one-time pairing code from ROZLF, and posts only the ciphertext over HTTPS.

What it deliberately does NOT do:
  * no password collection, no login automation, no click simulation;
  * no reading or decrypting of Safari/Chrome/Edge cookie databases;
  * no token in argv, in logs, in Telegram or on the ROZLF page;
  * no trade execution - ROZLF stays read/analysis only.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KDF_SALT = b"rozlf-connect-v1"
KDF_ITERATIONS = 200_000
AAD = b"rozlf-connect"
LOGIN_URL = "https://m.expertoption.com"
SESSION_COOKIE = "token"


def normalize_code(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def derive_key(code: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", normalize_code(code).encode(), KDF_SALT, KDF_ITERATIONS, 32)


def encrypt_payload(code: str, plaintext: str) -> dict:
    iv = os.urandom(12)
    key = derive_key(code)
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore
        sealed = AESGCM(key).encrypt(iv, plaintext.encode(), AAD)
        ct, tag = sealed[:-16], sealed[-16:]
    except ImportError:  # pragma: no cover
        from Crypto.Cipher import AES  # type: ignore
        cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
        cipher.update(AAD)
        ct, tag = cipher.encrypt_and_digest(plaintext.encode())
    return {
        "v": 1,
        "kdf": f"pbkdf2-sha256-{KDF_ITERATIONS}",
        "iv": base64.b64encode(iv).decode(),
        "ct": base64.b64encode(ct).decode(),
        "tag": base64.b64encode(tag).decode(),
    }


def extract_token(cookie_header: str, local_storage: dict) -> str:
    for part in (cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name.strip().lower() == SESSION_COOKIE and value.strip():
            return urllib.parse.unquote(value.strip())
    for key, value in (local_storage or {}).items():
        if not isinstance(value, str) or not value.strip():
            continue
        if re.search(r"(token|session|jwt|auth)", key, re.I):
            candidate = value.strip().strip('"')
            if candidate[:1] in "{[":
                try:
                    blob = json.loads(candidate)
                except ValueError:
                    continue
                for inner_key in ("token", "sessionToken", "access_token", "accessToken", "jwt"):
                    inner = blob.get(inner_key) if isinstance(blob, dict) else None
                    if isinstance(inner, str) and inner.strip():
                        return inner.strip()
                continue
            if len(candidate) >= 24 and " " not in candidate:
                return candidate
    return ""


def mask(token: str) -> str:
    if len(token) <= 10:
        return "*" * len(token)
    return f"{token[:4]}…{token[-4:]} ({len(token)} chars)"


READ_STATE_JS = """() => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    ls[k] = localStorage.getItem(k);
  }
  return { cookie: document.cookie || '', ls };
}"""

LABEL_JS = """() => {
  for (const k of Object.keys(localStorage)) {
    if (/mail|login|account|user/i.test(k)) {
      const v = localStorage.getItem(k) || '';
      if (v && v.length < 80) return v;
    }
  }
  return '';
}"""


def capture_with_browser(wait_seconds: int) -> tuple:
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError:
        raise SystemExit(
            "Playwright غير مثبت. نفّذ:  pip install playwright  ثم  playwright install chromium\n"
            "أو استخدم  --paste  للصق قيمة token التي تراها في متصفحك."
        )

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=False)
        except Exception as exc:
            raise SystemExit(
                "تعذّر فتح نافذة المتصفح. نفّذ: playwright install chromium\n"
                "أو استخدم --paste للصق قيمة token يدوياً.\n"
                f"تفاصيل: {str(exc)[:160]}"
            )
        context = browser.new_context()
        page = context.new_page()
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=90_000)
        print("\nسجّل الدخول إلى حسابك (Demo) في النافذة التي فُتحت. لا تُغلق النافذة.")
        print("سأقرأ رمز الجلسة بعد أن يكتمل الدخول. Ctrl+C للإلغاء.\n")
        deadline = time.time() + wait_seconds
        try:
            while time.time() < deadline:
                try:
                    state = page.evaluate(READ_STATE_JS)
                except Exception:
                    time.sleep(2)
                    continue
                token = extract_token(state.get("cookie", ""), state.get("ls", {}))
                if token:
                    try:
                        label = str(page.evaluate(LABEL_JS) or "").strip()
                    except Exception:
                        label = ""
                    return token, label
                time.sleep(2)
        finally:
            context.close()
            browser.close()
    raise SystemExit(
        "لم أجد رمز جلسة بعد انتهاء مدة الانتظار. تأكد أنك أكملت تسجيل الدخول داخل نافذة الموصّل، أو استخدم --paste."
    )


def post_json(url: str, payload: dict) -> tuple:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:  # TLS verified by default
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            return exc.code, json.loads(body or "{}")
        except ValueError:
            return exc.code, {"detail": body[:300]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="ROZLF ExpertOption consent connector (read-only)")
    parser.add_argument("--app", default="https://rozlf-auto-triding-1.onrender.com", help="ROZLF base URL")
    parser.add_argument("--code", help="one-time pairing code shown in ROZLF")
    parser.add_argument("--paste", action="store_true", help="paste the token instead of opening a browser")
    parser.add_argument("--wait", type=int, default=300, help="seconds to wait for your login")
    parser.add_argument("--self-test", action="store_true", help="verify the crypto round trip and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        blob = encrypt_payload("ABCD-2345", "self-test-token")
        print(f"payload fields: {sorted(blob)} ({len(blob['ct'])} bytes ciphertext, no plaintext)")
        return 0

    code = args.code or input("رمز الربط من ROZLF: ").strip()
    if not re.match(r"^[A-Za-z0-9-]{8,16}$", code):
        print("صيغة الرمز غير صحيحة.")
        return 2

    app_url = args.app.rstrip("/")
    if not app_url.startswith("https://") and not app_url.startswith("http://localhost"):
        print("لن أرسل الجلسة عبر اتصال غير مشفّر. استخدم https:// أو localhost للتطوير.")
        return 2

    if args.paste:
        token = getpass.getpass("ألصق قيمة token (لن تظهر على الشاشة): ").strip()
        label = ""
    else:
        token, label = capture_with_browser(args.wait)

    if not token:
        print("لم أجد رمز جلسة. لن أرسل شيئاً.")
        return 1

    blob = encrypt_payload(code, token)
    print(f"تم تشفير الجلسة على جهازك: {mask(token)}")
    body = {"code": code, "payload": blob, "account_type": "demo"}
    if label:
        body["login"] = label[:120]
    status, reply = post_json(f"{app_url}/api/connect/session", body)
    if status == 200:
        verified = bool((reply.get("session") or {}).get("verified"))
        print("تم إرسال الجلسة إلى ROZLF." + (" والتحقق نجح ✅" if verified else ""))
        if not verified:
            reason = (reply.get("session") or {}).get("last_error") or "لم يتحقق الاتصال"
            print(f"الخادم لم يؤكد الاتصال: {str(reason)[:200]}")
        return 0 if verified else 1
    print(f"رفض الخادم الطلب ({status}): {str(reply.get('detail'))[:300]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
