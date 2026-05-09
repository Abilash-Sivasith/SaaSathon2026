#!/usr/bin/env python3
"""Simple OpenAI API key check.

Reads OPENAI_API_KEY from environment and makes a minimal request.
"""

import os
from pathlib import Path
from openai import OpenAI


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> None:
    load_dotenv(Path(__file__).with_name('.env'))
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    # Minimal request to verify auth; keep it cheap.
    _ = client.models.list()
    print("OK: key is valid and API reachable")


if __name__ == "__main__":
    main()
