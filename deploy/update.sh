#!/bin/sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null

if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree has local changes. Commit or move them before updating." >&2
    exit 1
fi
branch=$(git symbolic-ref --quiet --short HEAD) || {
    echo "Detached HEAD: switch to your deployment branch before updating." >&2
    exit 1
}
git rev-parse --verify '@{upstream}' >/dev/null
previous=$(git rev-parse HEAD)
echo "Updating branch $branch. Previous revision: $previous"
git pull --ff-only
docker compose config --quiet
# Build while the currently running container keeps serving the previous image.
docker compose build
docker compose up -d --no-build --wait --wait-timeout 60
docker compose ps
echo "Deployed revision: $(git rev-parse HEAD)"
