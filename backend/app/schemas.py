import uuid
from datetime import datetime

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, computed_field, field_validator

from app.models import JobSource, JobStatus, UserRole
from app.security import (
    normalize_username,
    validate_display_name,
    validate_password,
    validate_source_url,
)


def format_stem_label(stem_name: str) -> str:
    if stem_name == "original":
        return "Original mix"
    if stem_name.startswith("no_"):
        base = stem_name[3:].casefold()
        if base == "drums":
            return "No Drums (Drumless)"
        if base == "vocals":
            return "No Vocals (Karaoke)"
        if base == "bass":
            return "No Bass"
        if base == "guitar":
            return "No Guitar"
        if base == "piano":
            return "No Piano"
        if base == "other":
            return "No Other"
        return f"No {base.capitalize()}"
    return stem_name.capitalize()


class UserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    display_name: str
    role: UserRole


class UserOut(UserSummary):
    is_active: bool = Field(validation_alias="active")
    password_reminder_seen: bool
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None


class AuthOut(BaseModel):
    user: UserOut
    show_password_reminder: bool


class LoginIn(BaseModel):
    username: str
    password: str = Field(min_length=1, max_length=1024)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str

    @field_validator("new_password")
    @classmethod
    def strong_password(cls, value: str) -> str:
        return validate_password(value)


class UserCreate(BaseModel):
    username: str
    display_name: str
    role: UserRole = UserRole.USER
    active: bool = Field(
        default=True,
        validation_alias=AliasChoices("active", "is_active"),
    )
    password: str | None = None

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str) -> str:
        return normalize_username(value)

    @field_validator("display_name")
    @classmethod
    def valid_display_name(cls, value: str) -> str:
        return validate_display_name(value)

    @field_validator("password")
    @classmethod
    def strong_password(cls, value: str | None) -> str | None:
        return validate_password(value) if value is not None else None


class UserPatch(BaseModel):
    username: str | None = None
    display_name: str | None = None
    role: UserRole | None = None
    active: bool | None = Field(
        default=None,
        validation_alias=AliasChoices("active", "is_active"),
    )

    @field_validator("username")
    @classmethod
    def valid_username(cls, value: str | None) -> str | None:
        return normalize_username(value) if value is not None else None

    @field_validator("display_name")
    @classmethod
    def valid_display_name(cls, value: str | None) -> str | None:
        return validate_display_name(value) if value is not None else None


class PasswordResetIn(BaseModel):
    password: str | None = None

    @field_validator("password")
    @classmethod
    def strong_password(cls, value: str | None) -> str | None:
        return validate_password(value) if value is not None else None


class PasswordIssuedOut(BaseModel):
    user: UserOut
    generated_password: str | None


class AdminUserOut(UserOut):
    job_count: int = 0
    storage_bytes: int = 0


class StemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    filename: str
    media_type: str
    size: int = Field(validation_alias="size_bytes")
    sha256: str
    created_at: datetime

    @computed_field
    @property
    def stem_type(self) -> str:
        if self.name == "original":
            return "source"
        if self.name.startswith("no_"):
            return "stemless"
        return "isolated"

    @computed_field
    @property
    def display_name(self) -> str:
        return format_stem_label(self.name)


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    remote_job_id: str | None
    source_type: JobSource = Field(validation_alias="source")
    filename: str | None
    title: str | None
    source_url: str | None
    include_original: bool
    model: str
    output_format: str
    mp3_bitrate: int | None
    requested_stems: list[str] = Field(default_factory=list)
    status: JobStatus
    progress_pct: float = Field(validation_alias="progress")
    error_message: str | None = Field(validation_alias="error")
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    expires_at: datetime | None
    archive_attempts: int
    remote_deleted: bool
    owner: UserSummary | None = None
    stems: list[StemOut] = Field(default_factory=list)

    @field_validator("requested_stems", mode="before")
    @classmethod
    def parse_requested_stems(cls, value: str | list[str] | None) -> list[str]:
        if isinstance(value, str):
            return [stem for stem in value.split(",") if stem]
        return value or []


class JobListOut(BaseModel):
    items: list[JobOut]
    total: int
    limit: int
    offset: int


class JobPatch(BaseModel):
    title: str = Field(min_length=1, max_length=255)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        title = value.strip()
        if not title or any(ord(character) < 32 for character in title):
            raise ValueError("Title must contain printable characters")
        return title


class UserListOut(BaseModel):
    items: list[AdminUserOut]
    total: int
    limit: int
    offset: int


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None


class SessionListOut(BaseModel):
    items: list[SessionOut]


class SeparationOptionsIn(BaseModel):
    model: str = Field(min_length=1, max_length=100)
    output_format: str = "mp3"
    mp3_bitrate: int | None = 320
    stems: list[str] | None = None
    include_original: bool = False


class UrlJobIn(BaseModel):
    url: str
    options: SeparationOptionsIn

    @field_validator("url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        return validate_source_url(value)


class AppSettingsOut(BaseModel):
    retention_days: int
    delete_remote_after_archive: bool
    updated_at: datetime


class AppSettingsPatch(BaseModel):
    retention_days: int | None = Field(default=None, ge=1, le=3650)
    delete_remote_after_archive: bool | None = None


class ModelInfo(BaseModel):
    id: str
    name: str
    description: str
    stems: list[str] = Field(default_factory=list)
    is_default: bool = False
    quality: str | None = None
    speed: str | None = None


class ModelsOut(BaseModel):
    items: list[ModelInfo]
    live: bool


class OverviewOut(BaseModel):
    health: str
    demucster_healthy: bool
    demucster_detail: str | None
    demucster: dict[str, object] = Field(default_factory=dict)
    queue: dict[str, object] = Field(default_factory=dict)
    gpu: dict[str, object] = Field(default_factory=dict)
    dgx: dict[str, object] = Field(default_factory=dict)
    archive: dict[str, object] = Field(default_factory=dict)
    counts: dict[str, int] = Field(default_factory=dict)
    disk_total_bytes: int
    disk_free_bytes: int
    disk_used_bytes: int
    archive_bytes: int
    jobs_by_status: dict[str, int]
    user_count: int
