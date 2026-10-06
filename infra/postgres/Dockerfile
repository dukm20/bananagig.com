# The official postgis/postgis image has no linux/arm64 build, so we layer PostGIS onto the
# official multi-arch postgres image using the PGDG apt repo that ships inside it.
# trivy:ignore:AVD-DS-0002 -- the official postgres entrypoint starts as root only to fix volume ownership, then drops to the postgres user via gosu.
FROM postgres:17.6-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
COPY enable-postgis.sh /docker-entrypoint-initdb.d/00-postgis.sh
