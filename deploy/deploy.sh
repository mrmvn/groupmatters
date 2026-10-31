#!/bin/sh
# Deploy = push to git, then pull on the server and restart.
# Host details are NOT in the repo: use an ssh alias from ~/.ssh/config
# and/or a git-ignored .deploy.env (see deploy/deploy.env.example).
set -eu
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && . ./.deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST (ssh alias or user@host), e.g. in .deploy.env}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/groupmatters}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-groupmatters}"

# The server can only run what is committed and pushed
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes: commit first." >&2; exit 1
fi
git fetch -q
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then
  echo "Local HEAD differs from its upstream: push (or pull) first." >&2; exit 1
fi

if [ "${SKIP_TESTS:-}" != 1 ]; then
  npm run typecheck
  npm test
fi

ssh "$DEPLOY_HOST" "cd $DEPLOY_PATH && git pull --ff-only && sudo systemctl restart $DEPLOY_SERVICE && sleep 2 && curl -fsS http://127.0.0.1:3000/healthz && echo && systemctl is-active $DEPLOY_SERVICE"
