"""Add drum transcription and transcription_files tables.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "transcriptions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("stem_name", sa.String(length=160), nullable=False),
        sa.Column("remote_id", sa.String(length=255), nullable=True),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("options_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("summary_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archive_attempts", sa.Integer(), nullable=False),
        sa.Column("remote_deleted", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("remote_id"),
    )
    op.create_index("ix_transcriptions_job_id", "transcriptions", ["job_id"], unique=False)
    op.create_index("ix_transcriptions_remote_id", "transcriptions", ["remote_id"], unique=True)
    op.create_index("ix_transcriptions_status", "transcriptions", ["status"], unique=False)
    op.create_index(
        "ix_transcriptions_status_updated",
        "transcriptions",
        ["status", "updated_at"],
        unique=False,
    )

    op.create_table(
        "transcription_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("transcription_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("relative_path", sa.String(length=500), nullable=False),
        sa.Column("media_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["transcription_id"], ["transcriptions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("transcription_id", "kind", name="uq_transcription_file_kind"),
    )
    op.create_index(
        "ix_transcription_files_transcription_id",
        "transcription_files",
        ["transcription_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_transcription_files_transcription_id", table_name="transcription_files")
    op.drop_table("transcription_files")
    op.drop_index("ix_transcriptions_status_updated", table_name="transcriptions")
    op.drop_index("ix_transcriptions_status", table_name="transcriptions")
    op.drop_index("ix_transcriptions_remote_id", table_name="transcriptions")
    op.drop_index("ix_transcriptions_job_id", table_name="transcriptions")
    op.drop_table("transcriptions")

