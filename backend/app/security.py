import hashlib
import ipaddress
import re
import secrets
import unicodedata
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from fastapi import HTTPException, status
from pwdlib import PasswordHash

password_hash = PasswordHash.recommended()
DUMMY_PASSWORD_HASH = password_hash.hash("Detangle-Dummy-Password1!")
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
SAFE_COMPONENT_RE = re.compile(r"[^A-Za-z0-9._ -]+")
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}


def normalize_username(value: str) -> str:
    username = unicodedata.normalize("NFKC", value).strip().casefold()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError(
            "Username must be 3-64 characters and use letters, numbers, dot, dash, or underscore"
        )
    return username


def validate_display_name(value: str) -> str:
    name = unicodedata.normalize("NFKC", value).strip()
    if not 1 <= len(name) <= 120 or any(ord(char) < 32 for char in name):
        raise ValueError("Display name must be 1-120 printable characters")
    return name


def validate_password(value: str) -> str:
    if len(value) < 12:
        raise ValueError("Password must be at least 12 characters")
    if len(value) > 1024:
        raise ValueError("Password is too long")
    classes = (
        any(char.islower() for char in value),
        any(char.isupper() for char in value),
        any(char.isdigit() for char in value),
        any(not char.isalnum() for char in value),
    )
    if sum(classes) < 3:
        raise ValueError("Password must contain at least three character types")
    return value


def hash_password(value: str) -> str:
    return password_hash.hash(validate_password(value))


def verify_password(value: str, encoded: str) -> bool:
    try:
        return password_hash.verify(value, encoded)
    except Exception:
        return False


def generate_password() -> str:
    # 192 random bits, with guaranteed character-class diversity.
    return f"Aa1!{secrets.token_urlsafe(24)}"


def generate_session_token() -> str:
    return secrets.token_urlsafe(48)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def session_expiry(days: int) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)


def safe_upload_filename(value: str | None) -> str:
    if not value:
        raise ValueError("A filename is required")
    raw_name = Path(value.replace("\\", "/")).name
    name = SAFE_COMPONENT_RE.sub("_", unicodedata.normalize("NFKC", raw_name)).strip(" .")
    if not name or len(name) > 255:
        raise ValueError("Invalid filename")
    if Path(name).suffix.casefold() not in AUDIO_EXTENSIONS:
        raise ValueError("Unsupported audio extension")
    return name


def safe_stem_filename(value: str, output_format: str) -> str:
    raw_name = Path(value.replace("\\", "/")).name
    name = SAFE_COMPONENT_RE.sub("_", unicodedata.normalize("NFKC", raw_name)).strip(" .")
    if not name:
        raise ValueError("Invalid stem filename")
    suffix = Path(name).suffix.casefold()
    expected = f".{output_format.casefold()}"
    if not suffix:
        name += expected
    elif suffix != expected or suffix not in AUDIO_EXTENSIONS:
        raise ValueError("Unexpected stem format")
    if len(name) > 255:
        raise ValueError("Stem filename is too long")
    return name


def validate_source_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username:
        raise ValueError("A public HTTP(S) URL is required")
    hostname = parsed.hostname.casefold()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise ValueError("Private URLs are not allowed")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise ValueError("Private URLs are not allowed")
    if len(value) > 4096:
        raise ValueError("URL is too long")
    return value.strip()


class LoginThrottle:
    def __init__(self, attempts: int = 5, window_seconds: int = 300) -> None:
        self.attempts = attempts
        self.window = timedelta(seconds=window_seconds)
        self.failures: dict[str, deque[datetime]] = defaultdict(deque)

    def _prune(self, key: str, now: datetime) -> deque[datetime]:
        entries = self.failures[key]
        while entries and now - entries[0] > self.window:
            entries.popleft()
        return entries

    def check(self, key: str) -> None:
        if len(self._prune(key, datetime.now(UTC))) >= self.attempts:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts; try again later",
                headers={"Retry-After": str(int(self.window.total_seconds()))},
            )

    def fail(self, key: str) -> None:
        self._prune(key, datetime.now(UTC)).append(datetime.now(UTC))

    def clear(self, key: str) -> None:
        self.failures.pop(key, None)
