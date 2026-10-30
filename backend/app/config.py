from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    demucster_url: str = "http://192.168.50.93:9841"
    drumster_url: str = "http://192.168.50.93:9842"
    transcription_enabled: bool = True
    database_url: str = "sqlite+aiosqlite:////data/detangle.db"
    data_dir: Path = Path("/data")
    frontend_dir: Path = Path("/app/frontend")

    session_cookie_name: str = "detangle_session"
    session_days: int = Field(default=14, ge=1, le=365)
    cookie_secure: bool = False
    trusted_hosts: str = "*"

    initial_admin_username: str = "admin"
    initial_admin_password: SecretStr | None = None
    initial_admin_display_name: str = "Administrator"

    max_upload_mb: int = Field(default=500, ge=1, le=10_000)
    poll_interval_seconds: float = Field(default=3, ge=0.2)
    archive_concurrency: int = Field(default=2, ge=1, le=16)
    default_retention_days: int = Field(default=30, ge=1, le=3650)
    delete_remote_after_archive: bool = False
    retention_sweep_minutes: int = Field(default=30, ge=1, le=1440)
    log_level: str = "INFO"
    disable_background_tasks: bool = False

    @field_validator("demucster_url", "drumster_url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def trusted_host_list(self) -> list[str]:
        return [host.strip() for host in self.trusted_hosts.split(",") if host.strip()]

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
