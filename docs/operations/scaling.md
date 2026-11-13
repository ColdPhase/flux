# Capacity and scaling

Flux is built for a team on one server. One Compose project runs one PostgreSQL, one API, one
worker and one keyring on one Docker host, and that is the only deployment that is tested.

## Grow the one server

- **Memory.** Raise `FLUX_API_MEMORY` (default `1536m`), `FLUX_WORKER_MEMORY` (`512m`) and
  `FLUX_DB_MEMORY` (`768m`) in the settings file and apply them with `./flux up`. A container that reaches its limit is killed and restarted;
  for the API that also locks every [encrypted space](encrypted-spaces.md). `docker stats` shows how
  close each one runs.
- **Database.** Each API and worker process keeps a pool of 10 PostgreSQL connections, and
  PostgreSQL keeps its default of 100. Give the host fast disk before more CPU: every write ends with
  an ordered event insert. PostgreSQL itself runs with its image defaults; tune it through a Compose
  override file only if you measure a need (`./flux` reads `docker/compose.override.yaml`).
- **Disk.** The database keeps every saved version. Watch the `pgdata` volume and keep room for a
  backup, which needs about twice its size while it is written.
- **Agent runtime.** Everyone with Connect AI has a place; how many agents run at once follows from
  memory, about 2 on 4 GB, and the others wait ([what each agent needs](agent-runtime.md#what-each-agent-needs)).
- **Live media.** Calls run in LiveKit with a configured limit of 16 people per room; CPU and
  bandwidth grow with each call. That limit is configured, not a measured capacity.

The [performance measurements of October 2026](../development/performance-2026-10.md) record what
was measured on a seeded data set, with the method.

## More than one server

Running several API or worker containers, PostgreSQL on another host, or Flux across several nodes
is not supported in this version:

- the keyring must be exactly one per deployment and reach `api` and `worker` over a private network
  on the same host;
- `api` and `worker` share the `files` volume as a local directory;
- nothing in the shipped files deploys, tests or documents more than one of each.

Several **independent** instances on one host are fine: each checkout gets its own Compose project,
volumes and port. Watch Docker's address pools when you run many
([Docker address pools](troubleshooting.md#docker-address-pools)).
