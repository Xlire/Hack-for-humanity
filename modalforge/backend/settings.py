"""Allsolve credentials from the project-root .env file. Re-readable at runtime (no restart needed)."""

from __future__ import annotations

from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
PLACEHOLDERS = {"", "your-access-key-here", "your-secret-key-here"}
DEFAULT_HOST = "https://allsolve.quanscient.com/"

try:
    import allsolve  # noqa: F401

    SDK_AVAILABLE = True
    SDK_VERSION = getattr(allsolve, "__version__", "installed")
except Exception:  # pragma: no cover - depends on environment
    SDK_AVAILABLE = False
    SDK_VERSION = None


class Credentials:
    def __init__(self) -> None:
        self.access_key = ""
        self.secret_key = ""
        self.host = DEFAULT_HOST
        self.reload()

    def reload(self) -> None:
        values = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}
        self.access_key = (values.get("ALLSOLVE_ACCESS_KEY") or "").strip()
        self.secret_key = (values.get("ALLSOLVE_SECRET_KEY") or "").strip()
        self.host = (values.get("ALLSOLVE_HOST") or DEFAULT_HOST).strip()

    @property
    def configured(self) -> bool:
        return self.access_key not in PLACEHOLDERS and self.secret_key not in PLACEHOLDERS

    def public_status(self) -> dict:
        return {
            "envFile": str(ENV_FILE),
            "envFileExists": ENV_FILE.exists(),
            "configured": self.configured,
            "host": self.host,
            "accessKeyHint": (self.access_key[:4] + "…") if self.configured else None,
            "sdkInstalled": SDK_AVAILABLE,
            "sdkVersion": SDK_VERSION,
        }


credentials = Credentials()


def make_client():
    """Authenticated Allsolve client. Explicit keys, so the server's working directory never matters."""
    import allsolve

    if not credentials.configured:
        raise RuntimeError("Allsolve API key is not set. Add it to .env and press Reload keys.")
    cache_dir = ROOT / "cache" / "allsolve_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return allsolve.Client(
        api_key=credentials.access_key,
        api_secret=credentials.secret_key,
        host=credentials.host,
        cache_base_dir=str(cache_dir),
        dotenv_file=None,
    )
