\if :{?maintainer_role}
\else
\echo 'missing psql variable: maintainer_role'
\quit 2
\endif

CREATE SCHEMA IF NOT EXISTS access_control;
SELECT format('ALTER SCHEMA access_control OWNER TO %I', :'maintainer_role') \gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tb_employee_base') THEN
    CREATE ROLE tb_employee_base NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tb_all_datasets') THEN
    CREATE ROLE tb_all_datasets NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION access_control.ensure_managed_role(role_name text,login_allowed boolean,password_value text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF role_name !~ '^tb_(emp_[a-z][a-z0-9]{1,24}|dept_[a-z0-9_]{1,40})$'
     AND role_name NOT IN ('tb_employee_base','tb_all_datasets') THEN
    RAISE EXCEPTION 'unmanaged role name';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN RETURN false; END IF;
  IF login_allowed THEN
    IF password_value IS NULL OR length(password_value)<20 THEN RAISE EXCEPTION 'managed login requires generated password'; END IF;
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD %L',role_name,password_value);
  ELSE
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION access_control.grant_managed_role(granted_role text,member_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF granted_role !~ '^tb_(emp_[a-z][a-z0-9]{1,24}|dept_[a-z0-9_]{1,40})$'
     AND granted_role NOT IN ('tb_employee_base','tb_all_datasets') THEN
    RAISE EXCEPTION 'unmanaged granted role';
  END IF;
  IF member_role !~ '^tb_(emp_[a-z][a-z0-9]{1,24}|dept_[a-z0-9_]{1,40}|agent)$' THEN
    RAISE EXCEPTION 'unmanaged member role';
  END IF;
  EXECUTE format('GRANT %I TO %I',granted_role,member_role);
END
$$;

REVOKE ALL ON FUNCTION access_control.ensure_managed_role(text,boolean,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION access_control.grant_managed_role(text,text) FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA access_control TO %I', :'maintainer_role') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION access_control.ensure_managed_role(text,boolean,text) TO %I', :'maintainer_role') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION access_control.grant_managed_role(text,text) TO %I', :'maintainer_role') \gexec

SELECT 'EMPLOYEE_ACCESS_BOOTSTRAP_READY' AS status;
