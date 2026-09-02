import argparse
import asyncio

import uvicorn

from app.config import Settings
from app.main import create_app
from app.migrations import migrate


async def bootstrap_database(settings: Settings) -> None:
    settings.disable_background_tasks = True
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(prog="detangle")
    parser.add_argument("command", choices=("serve", "migrate", "bootstrap"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    settings = Settings()
    if args.command == "migrate":
        migrate(settings)
    elif args.command == "bootstrap":
        asyncio.run(bootstrap_database(settings))
    else:
        uvicorn.run("app.main:app", host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
