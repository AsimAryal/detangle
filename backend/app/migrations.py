from pathlib import Path

from alembic.config import Config

from alembic import command
from app.config import Settings


def alembic_config(settings: Settings) -> Config:
    path = Path(__file__).resolve().parents[1] / "alembic.ini"
    config = Config(path)
    config.set_main_option("sqlalchemy.url", settings.database_url)
    return config


def migrate(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    command.upgrade(alembic_config(settings), "head")
