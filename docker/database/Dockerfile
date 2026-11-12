# syntax=docker/dockerfile:1.7
# Flux's database image (F-037, #1242): the official PostgreSQL 18 on Debian with ParadeDB's pg_search (BM25 search inside
# PostgreSQL) and pgvector, which pg_search requires. Every input is pinned: the base by digest, pg_search's package by the
# sha256 its GitHub release states, pgvector by its exact Debian version from the PostgreSQL project's own repository.
#
# Licences: PostgreSQL and pgvector, PostgreSQL Licence; pg_search, AGPL-3.0-or-later (source: the v${PG_SEARCH_VERSION} tag of
# https://github.com/paradedb/paradedb, also in /usr/share/doc/postgresql-18-pg-search/); OpenBLAS (a pg_search dependency), BSD-3-Clause.
#
# Same behaviour as the Alpine image of v0.2.0, so an existing data directory starts here (docs/operations/upgrade.md):
# - Sorting. musl's en_US.utf8 compares text byte by byte; glibc's en_US.UTF-8 would sort by language and leave every text index
#   of an existing database in the wrong order. Here en_US.UTF-8 is built from glibc's C locale (byte order, Unicode case rules),
#   so ordinary indexes stay valid and ORDER BY gives the same order as before. Case mapping and character classes still differ
#   for about 100 (lower/upper) and 9,900 (to_tsvector, show_trgm) rare or recent code points: migration 0065 recomputes the
#   stored search columns and rebuilds the indexes derived from those functions.
# - The postgres user and group keep Alpine's ids (70), so the data directory's owner does not change in either direction.
ARG PG_SEARCH_VERSION=0.26.6

FROM scratch AS pg-search-amd64
ARG PG_SEARCH_VERSION
ADD --checksum=sha256:7553b976363afd7144e51585d281fee006edc17b6e83b75ce0d23921a13150a9 \
  https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/postgresql-18-pg-search_${PG_SEARCH_VERSION}-1PARADEDB-trixie_amd64.deb /pg-search.deb

FROM scratch AS pg-search-arm64
ARG PG_SEARCH_VERSION
ADD --checksum=sha256:af76ca5a1ebff0c2a9ec9c5b5b383ffc8557965f72829a4f35c72846a4ec987f \
  https://github.com/paradedb/paradedb/releases/download/v${PG_SEARCH_VERSION}/postgresql-18-pg-search_${PG_SEARCH_VERSION}-1PARADEDB-trixie_arm64.deb /pg-search.deb

FROM pg-search-${TARGETARCH} AS pg-search

# postgres:18.6-trixie (Debian 13)
FROM postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42
ARG PG_SEARCH_VERSION
# The pgvector build for this PostgreSQL minor (a later build may require a newer server, which the check below refuses).
ARG PGVECTOR_VERSION=0.8.7-1.pgdg13+1
RUN --mount=type=bind,from=pg-search,source=/pg-search.deb,target=/tmp/pg-search.deb \
  set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends "postgresql-18-pgvector=${PGVECTOR_VERSION}" /tmp/pg-search.deb; \
  # Debian's security updates of the base (the image scan allows no fixable HIGH/CRITICAL finding); PostgreSQL itself stays at
  # the base's version, which a newer build in the PostgreSQL repository would otherwise replace.
  apt-mark hold $(dpkg-query -W -f '${db:Status-Abbrev}${Package}\n' 'postgresql*' 'libpq*' | sed -n 's/^ii *//p'); \
  apt-get upgrade -y --no-install-recommends; \
  rm -rf /var/lib/apt/lists/*; \
  test "$(dpkg-query -W -f='${Version}' postgresql-18)" = "$PG_VERSION"; \
  localedef --replace -i C -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8; \
  groupmod -g 70 postgres; usermod -u 70 -g 70 postgres; \
  chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql; \
  rm /usr/local/bin/gosu
# gosu postgres <command>, as docker-entrypoint.sh calls it, through util-linux's setpriv (see the file).
COPY --chmod=0755 gosu /usr/local/bin/gosu
LABEL org.opencontainers.image.title="Flux database" \
  org.opencontainers.image.description="PostgreSQL 18 with pg_search ${PG_SEARCH_VERSION} and pgvector for Flux" \
  org.opencontainers.image.source="https://github.com/ColdPhase/flux" \
  org.opencontainers.image.licenses="PostgreSQL AND AGPL-3.0-or-later AND BSD-3-Clause"
# pg_search works only when preloaded: the entrypoint adds it to whatever command the container is given.
COPY --chmod=0755 flux-database-entrypoint.sh /usr/local/bin/flux-database-entrypoint.sh
ENTRYPOINT ["flux-database-entrypoint.sh"]
CMD ["postgres"]
