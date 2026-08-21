# FAOS Self-Hosted Fork Workflow

This fork keeps upstream Hermes Agent easy to update while carrying a small FAOS
deployment layer for Frank's personal agent.

## Branches

- `main`: tracks `frank-luongt/hermes-agent` and should stay close to
  `NousResearch/hermes-agent/main`.
- `faos/self-hosted`: carries FAOS-specific Docker and local runtime setup.

## Remotes

- `origin`: `https://github.com/frank-luongt/hermes-agent.git`
- `upstream`: `https://github.com/NousResearch/hermes-agent.git`

The local `upstream` push URL should stay disabled to avoid accidental pushes
to NousResearch.

## Runtime Data

Secrets, sessions, skills, cron state, and FAOS context packs live outside the
repository:

```text
/Users/thanhlt/.faos/hermes-frank
```

Do not commit runtime state or secrets.

## Local Update Flow

```bash
git fetch upstream
git checkout faos/self-hosted
git rebase upstream/main
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose -f docker-compose.frank.yml up -d --build
```

After rebuild, verify:

```bash
curl -sS http://127.0.0.1:9119/api/status
curl -sS http://127.0.0.1:8642/health
docker exec hermes-frank /opt/hermes/.venv/bin/hermes cron list
```

## FAOS Patch Boundary

Keep this branch limited to deployment concerns:

- `docker-compose.frank.yml`
- FAOS context repo read-only mount
- `~/.faos/hermes-frank` data volume
- local dashboard and gateway defaults
- runtime ownership fixes needed by the self-hosted image

Push generally useful fixes upstream to NousResearch when possible. FAOS should
own deployment, skills, policy, context refresh, and AgentOS integration around
Hermes rather than forking Hermes core behavior.
