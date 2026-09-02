# Detangle backend

Python 3.12/FastAPI service for authenticated Demucster job submission and durable
local stem archiving.

## Run

Set `INITIAL_ADMIN_PASSWORD` to a unique password of at least 12 characters with
three character classes. Then:

```console
uv sync --extra dev
uv run detangle migrate
uv run detangle serve
```

`detangle serve` intentionally starts one worker because the in-process archiver
and login throttle are designed for a single application worker. The app also
runs pending Alembic migrations and bootstraps the initial admin at startup.

The production defaults expect persistent storage mounted at `/data`. Copy
`.env.example` to `.env` and review every setting before deployment. When TLS is
terminated at the application or a trusted proxy, set `COOKIE_SECURE=true`.

## Checks

```console
uv run ruff check .
uv run pytest -q
```
