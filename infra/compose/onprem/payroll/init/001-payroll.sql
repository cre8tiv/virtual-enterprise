-- Payroll database (on-prem): employees, compensation, pay runs, payslips. Data is loaded in Phase 10.
-- Owned by payroll_owner (loaders); payroll_reader is the SUT's read-only login.
-- Idempotent; run by payroll-init as postgres with -v owner_pw=... -v reader_pw=...

-- Roles: create if missing, then (re)apply the password so it always matches the vault.
SELECT format('CREATE ROLE payroll_owner LOGIN PASSWORD %L', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payroll_owner') \gexec
SELECT format('ALTER ROLE payroll_owner LOGIN PASSWORD %L', :'owner_pw') \gexec

SELECT format('CREATE ROLE payroll_reader LOGIN PASSWORD %L', :'reader_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payroll_reader') \gexec
SELECT format('ALTER ROLE payroll_reader LOGIN PASSWORD %L', :'reader_pw') \gexec

REVOKE ALL ON DATABASE payroll FROM PUBLIC;
GRANT CONNECT ON DATABASE payroll TO payroll_owner, payroll_reader;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS payroll AUTHORIZATION payroll_owner;

SET ROLE payroll_owner;

CREATE TABLE IF NOT EXISTS payroll.employees (
  employee_id   text PRIMARY KEY,                -- canonical employee ID (E0001)
  upn           text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  department    text NOT NULL,
  cost_center   text NOT NULL,
  site          text NOT NULL,
  country       char(2) NOT NULL,
  currency      char(3) NOT NULL,
  hire_date     date NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  terminated_on date
);

CREATE TABLE IF NOT EXISTS payroll.compensation (
  employee_id      text NOT NULL REFERENCES payroll.employees (employee_id),
  effective_from   date NOT NULL,
  base_salary      numeric(12, 2) NOT NULL CHECK (base_salary > 0),
  currency         char(3) NOT NULL,
  pay_frequency    text NOT NULL CHECK (pay_frequency IN ('monthly', 'biweekly')),
  bonus_target_pct numeric(5, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS payroll.pay_runs (
  pay_run_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site         text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  pay_date     date NOT NULL,
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'paid' CHECK (status IN ('draft', 'approved', 'paid')),
  UNIQUE (site, period_start)
);

CREATE TABLE IF NOT EXISTS payroll.payslips (
  payslip_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pay_run_id  bigint NOT NULL REFERENCES payroll.pay_runs (pay_run_id),
  employee_id text NOT NULL REFERENCES payroll.employees (employee_id),
  gross       numeric(12, 2) NOT NULL,
  tax         numeric(12, 2) NOT NULL,
  deductions  numeric(12, 2) NOT NULL DEFAULT 0,
  net         numeric(12, 2) NOT NULL,
  currency    char(3) NOT NULL,
  UNIQUE (pay_run_id, employee_id)
);

RESET ROLE;

-- Read-only access for the SUT, including tables added later by payroll_owner.
GRANT USAGE ON SCHEMA payroll TO payroll_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA payroll TO payroll_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE payroll_owner IN SCHEMA payroll GRANT SELECT ON TABLES TO payroll_reader;
