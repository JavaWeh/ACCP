#!/bin/sh
set -eu
# Only PostgreSQL's one-time initialization receives role passwords.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$(cat /run/secrets/migrator_password)" \
  -v bootstrap_password="$(cat /run/secrets/bootstrap_password)" \
  -v api_password="$(cat /run/secrets/api_password)" \
  -v worker_password="$(cat /run/secrets/worker_password)" <<'SQL'
SELECT format('CREATE ROLE accp_migrator LOGIN PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE accp_bootstrap LOGIN PASSWORD %L', :'bootstrap_password') \gexec
SELECT format('CREATE ROLE accp_api LOGIN PASSWORD %L', :'api_password') \gexec
SELECT format('CREATE ROLE accp_worker LOGIN PASSWORD %L', :'worker_password') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE accp FROM PUBLIC;
GRANT CONNECT ON DATABASE accp TO accp_migrator,accp_bootstrap,accp_api,accp_worker;
CREATE SCHEMA accp AUTHORIZATION accp_migrator;
ALTER ROLE accp_migrator IN DATABASE accp SET search_path=accp;
ALTER ROLE accp_bootstrap IN DATABASE accp SET search_path=accp;
ALTER ROLE accp_api IN DATABASE accp SET search_path=accp;
ALTER ROLE accp_worker IN DATABASE accp SET search_path=accp;
SQL
