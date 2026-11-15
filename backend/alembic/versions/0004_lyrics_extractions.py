"""Add lyrics_extractions and lyrics_files tables.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lyrics_extractions",
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
    op.create_index("ix_lyrics_extractions_job_id", "lyrics_extractions", ["job_id"], unique=False)
    op.create_index(
        "ix_lyrics_extractions_remote_id", "lyrics_extractions", ["remote_id"], unique=True
    )
    op.create_index("ix_lyrics_extractions_status", "lyrics_extractions", ["status"], unique=False)
    op.create_index(
        "ix_lyrics_extractions_status_updated",
        "lyrics_extractions",
        ["status", "updated_at"],
        unique=False,
    )

    op.create_table(
        "lyrics_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("lyrics_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("relative_path", sa.String(length=500), nullable=False),
        sa.Column("media_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["lyrics_id"], ["lyrics_extractions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("lyrics_id", "kind", name="uq_lyrics_file_kind"),
    )
    op.create_index(
        "ix_lyrics_files_lyrics_id",
        "lyrics_files",
        ["lyrics_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_lyrics_files_lyrics_id", table_name="lyrics_files")
    op.drop_table("lyrics_files")
    op.drop_index("ix_lyrics_extractions_status_updated", table_name="lyrics_extractions")
    op.drop_index("ix_lyrics_extractions_status", table_name="lyrics_extractions")
    op.drop_index("ix_lyrics_extractions_remote_id", table_name="lyrics_extractions")
    op.drop_index("ix_lyrics_extractions_job_id", table_name="lyrics_extractions")
    op.drop_table("lyrics_extractions")

