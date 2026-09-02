import argparse
import asyncio
import getpass

import uvicorn
from sqlalchemy import delete, select

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.migrations import migrate
from app.models import Session, User
from app.security import hash_password, normalize_username


async def bootstrap_database(settings: Settings) -> None:
    settings.disable_background_tasks = True
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        pass


async def reset_account_password(
    settings: Settings,
    username: str,
    password: str,
) -> None:
    database = Database(settings.database_url)
    try:
        await database.initialize()
        async with database.sessions() as session:
            user = await session.scalar(
                select(User).where(User.username == normalize_username(username))
            )
            if user is None:
                raise ValueError(f"User not found: {username}")
            user.password_hash = await asyncio.to_thread(hash_password, password)
            await session.execute(delete(Session).where(Session.user_id == user.id))
            await session.commit()
    finally:
        await database.close()


async def list_accounts(settings: Settings) -> None:
    database = Database(settings.database_url)
    try:
        await database.initialize()
        async with database.sessions() as session:
            users = list(
                (
                    await session.scalars(
                        select(User).order_by(User.username)
                    )
                ).all()
            )
            if not users:
                print("No users found.")
            for user in users:
                state = "active" if user.active else "disabled"
                print(f"{user.username}\t{user.role.value}\t{state}")
    finally:
        await database.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="detangle")
    parser.add_argument(
        "command",
        choices=("serve", "migrate", "bootstrap", "list-users", "reset-password"),
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--username")
    args = parser.parse_args()
    settings = Settings()
    if args.command == "migrate":
        migrate(settings)
    elif args.command == "bootstrap":
        asyncio.run(bootstrap_database(settings))
    elif args.command == "list-users":
        migrate(settings)
        asyncio.run(list_accounts(settings))
    elif args.command == "reset-password":
        username = args.username or settings.initial_admin_username
        password = getpass.getpass("New password: ")
        confirmation = getpass.getpass("Confirm new password: ")
        if password != confirmation:
            parser.error("Passwords do not match")
        migrate(settings)
        try:
            asyncio.run(reset_account_password(settings, username, password))
        except ValueError as exc:
            parser.error(str(exc))
        print(f"Password updated and sessions revoked for {normalize_username(username)}.")
    else:
        uvicorn.run("app.main:app", host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
