import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import ExcelJS from '@excel.js/exceljs';
import { createReaderCredentialBundle } from './credential-bundle.mjs';

const EMPLOYEE_ROLE_PREFIX = 'tb_emp_';
const BASE_ROLE = 'tb_employee_base';
const ALL_DATA_ROLE = 'tb_all_datasets';

const DEPARTMENT_SLUGS = Object.freeze({
  '运营': 'ops',
  '外贸业务': 'foreign_trade',
  '设计': 'design',
  '客服': 'service',
  '管理': 'management',
  '工厂': 'factory',
  '短视频': 'video',
  '采购': 'procurement',
  '财务': 'finance',
});

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeEmployeeAccount(value) {
  const account = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,24}$/.test(account)) {
    throw new Error(`员工账号只能由小写字母和数字组成并以字母开头：${value}`);
  }
  return account;
}

export function employeeRoleName(account) {
  return `${EMPLOYEE_ROLE_PREFIX}${normalizeEmployeeAccount(account)}`;
}

export function departmentRoleName(department) {
  const value = String(department || '').trim();
  if (!value) throw new Error('员工部门不能为空');
  const slug = DEPARTMENT_SLUGS[value]
    || `d_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
  return `tb_dept_${slug}`;
}

function enabledValue(value) {
  return /^(是|yes|y|1|已开通|开通|需要|true|√)$/i.test(String(value || '').trim());
}

export async function readEnabledEmployeesFromWorkbook(input) {
  const resolved = path.resolve(input || '');
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error(`员工信息路径不是普通文件：${resolved}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(resolved);
  let matched = null;
  workbook.eachSheet((sheet) => {
    if (matched) return;
    sheet.eachRow((row, rowNumber) => {
      if (matched) return;
      const headers = row.values.slice(1).map((value) => String(value || '').trim());
      const databaseEnabled = headers.findIndex((value) => /数据库.*开通/.test(value));
      if (databaseEnabled >= 0) matched = { sheet, rowNumber, headers };
    });
  });
  if (!matched) throw new Error('员工信息表中找不到“数据库开通”列');
  const find = (pattern) => matched.headers.findIndex((value) => pattern.test(value));
  const indexes = {
    name: find(/员工|姓名/),
    department: find(/部门/),
    account: find(/账号/),
    enabled: find(/数据库.*开通/),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error('员工信息表必须包含员工名称、部门、账号名称和数据库开通列');
  }
  const employees = [];
  for (let rowNumber = matched.rowNumber + 1; rowNumber <= matched.sheet.rowCount; rowNumber += 1) {
    const values = matched.sheet.getRow(rowNumber).values.slice(1);
    if (!enabledValue(values[indexes.enabled])) continue;
    const employee = {
      name: String(values[indexes.name] || '').trim(),
      department: String(values[indexes.department] || '').trim(),
      account: normalizeEmployeeAccount(values[indexes.account]),
    };
    if (!employee.name || !employee.department) throw new Error(`第 ${rowNumber} 行缺少员工姓名或部门`);
    employees.push({
      ...employee,
      loginRole: employeeRoleName(employee.account),
      departmentRole: departmentRoleName(employee.department),
    });
  }
  if (employees.length === 0) throw new Error('没有找到标记为需要数据库开通的员工');
  const duplicates = employees.filter((entry, index) => employees.findIndex((item) => item.account === entry.account) !== index);
  if (duplicates.length) throw new Error(`数据库开通名单存在重复账号：${[...new Set(duplicates.map((entry) => entry.account))].join('、')}`);
  return { input: resolved, sheet: matched.sheet.name, employees };
}

async function requireRoleAdministration(client) {
  const result = await client.query(`
    SELECT current_user AS current_user,
      (SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname=current_user) AS can_manage_roles
  `);
  if (result.rows[0].can_manage_roles) return { direct: true, user: result.rows[0].current_user };
  const delegated = await client.query(`
    SELECT to_regprocedure('access_control.ensure_managed_role(text,boolean,text)') IS NOT NULL
        AND has_function_privilege(current_user,'access_control.ensure_managed_role(text,boolean,text)','EXECUTE') AS ensure_role,
      to_regprocedure('access_control.grant_managed_role(text,text)') IS NOT NULL
        AND has_function_privilege(current_user,'access_control.grant_managed_role(text,text)','EXECUTE') AS grant_role
  `);
  if (delegated.rows[0].ensure_role && delegated.rows[0].grant_role) {
    return { direct: false, user: result.rows[0].current_user };
  }
  throw new Error(`当前数据库身份 ${result.rows[0].current_user} 没有受限角色管理能力；请先执行 tbcli 附带的一次性 PostgreSQL 员工权限引导脚本`);
}

async function ensureRole(client, role, { login = false, password = null, roleAdmin } = {}) {
  const exists = await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
  if (exists.rowCount) return false;
  if (!roleAdmin?.direct) {
    const result = await client.query('SELECT access_control.ensure_managed_role($1,$2,$3) AS created', [role, login, password]);
    return Boolean(result.rows[0].created);
  }
  if (login) {
    await client.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD ${quoteLiteral(password)}`);
  } else {
    await client.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }
  return true;
}

async function grantManagedRole(client, grantedRole, memberRole, roleAdmin) {
  if (!roleAdmin?.direct) {
    await client.query('SELECT access_control.grant_managed_role($1,$2)', [grantedRole, memberRole]);
    return;
  }
  await client.query(`GRANT ${quoteIdentifier(grantedRole)} TO ${quoteIdentifier(memberRole)}`);
}

export async function ensureEmployeeAccessSchema(client, { globalReaderRole = 'tb_agent' } = {}) {
  const roleAdmin = await requireRoleAdministration(client);
  await ensureRole(client, BASE_ROLE, { roleAdmin });
  await ensureRole(client, ALL_DATA_ROLE, { roleAdmin });
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS access_control;
    REVOKE ALL ON SCHEMA access_control FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS access_control.employee_accounts (
      employee_account text PRIMARY KEY,
      login_role name UNIQUE NOT NULL,
      employee_name text NOT NULL,
      department text NOT NULL,
      department_role name NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS access_control.dataset_grants (
      grantee_role name NOT NULL,
      dataset_key text NOT NULL REFERENCES meta.datasets(dataset_key) ON DELETE CASCADE,
      granted_by name NOT NULL DEFAULT current_user,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(grantee_role,dataset_key)
    );
    CREATE TABLE IF NOT EXISTS access_control.table_grants (
      grantee_role name NOT NULL,
      relation_name text NOT NULL,
      granted_by name NOT NULL DEFAULT current_user,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(grantee_role,relation_name)
    );
    CREATE TABLE IF NOT EXISTS access_control.query_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      employee_role name NOT NULL,
      dataset_key text NOT NULL,
      query_context jsonb NOT NULL DEFAULT '{}'::jsonb,
      returned_rows integer NOT NULL,
      client_address inet,
      application_name text,
      queried_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE ALL ON ALL TABLES IN SCHEMA access_control FROM PUBLIC;
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION access_control.can_access_dataset(requested_dataset text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path=pg_catalog,access_control
    AS $$
      SELECT pg_has_role(session_user,'${ALL_DATA_ROLE}','member') OR EXISTS (
        SELECT 1 FROM access_control.dataset_grants g
        WHERE g.dataset_key=requested_dataset
          AND pg_has_role(session_user,g.grantee_role,'member')
      )
    $$;
    REVOKE ALL ON FUNCTION access_control.can_access_dataset(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION access_control.can_access_dataset(text) TO ${quoteIdentifier(BASE_ROLE)},${quoteIdentifier(ALL_DATA_ROLE)};

    CREATE OR REPLACE FUNCTION access_control.record_query(requested_dataset text,context jsonb,rows_returned integer)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path=pg_catalog,access_control
    AS $$
    BEGIN
      IF NOT pg_has_role(session_user,'${BASE_ROLE}','member') THEN
        RAISE EXCEPTION 'employee audit function is restricted';
      END IF;
      INSERT INTO access_control.query_audit(employee_role,dataset_key,query_context,returned_rows,client_address,application_name)
      VALUES(session_user,requested_dataset,coalesce(context,'{}'::jsonb),greatest(rows_returned,0),inet_client_addr(),current_setting('application_name',true));
    END
    $$;
    REVOKE ALL ON FUNCTION access_control.record_query(text,jsonb,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION access_control.record_query(text,jsonb,integer) TO ${quoteIdentifier(BASE_ROLE)};
  `);
  for (const [relation, expression] of [
    ['meta.datasets', 'access_control.can_access_dataset(dataset_key)'],
    ['meta.dataset_fields', 'access_control.can_access_dataset(dataset_key)'],
    ['raw.sycm_rows', 'access_control.can_access_dataset(dataset_key)'],
  ]) {
    await client.query(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`);
    const policy = `tbcli_employee_${relation.replace('.', '_')}`;
    await client.query(`DROP POLICY IF EXISTS ${quoteIdentifier(policy)} ON ${relation}`);
    await client.query(`CREATE POLICY ${quoteIdentifier(policy)} ON ${relation} FOR SELECT TO ${quoteIdentifier(BASE_ROLE)},${quoteIdentifier(ALL_DATA_ROLE)} USING (${expression})`);
  }
  const identity = await client.query('SELECT current_database() AS database');
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(identity.rows[0].database)} TO ${quoteIdentifier(BASE_ROLE)}`);
  await client.query(`GRANT USAGE ON SCHEMA access_control TO ${quoteIdentifier(BASE_ROLE)},${quoteIdentifier(ALL_DATA_ROLE)}`);
  await client.query(`GRANT USAGE ON SCHEMA meta,raw,mart TO ${quoteIdentifier(BASE_ROLE)}`);
  await client.query(`GRANT SELECT ON meta.datasets,meta.dataset_fields,raw.sycm_rows TO ${quoteIdentifier(BASE_ROLE)}`);
  const global = await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [globalReaderRole]);
  if (global.rowCount) await grantManagedRole(client, ALL_DATA_ROLE, globalReaderRole, roleAdmin);
  return { baseRole: BASE_ROLE, allDataRole: ALL_DATA_ROLE, globalReaderRole: global.rowCount ? globalReaderRole : null, delegatedRoleAdministration: !roleAdmin.direct };
}

function randomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

async function pathExists(target) {
  try { await fsp.stat(target); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function provisionEmployees(client, workbookInfo, options) {
  const credentialDir = path.resolve(options.credentialDir || '');
  if (!options.credentialDir) throw new Error('缺少员工凭据输出目录');
  await fsp.mkdir(credentialDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(credentialDir, 0o700);
  await client.query('BEGIN');
  let access;
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    access = await ensureEmployeeAccessSchema(client, options);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const roleAdmin = await requireRoleAdministration(client);
  const existing = new Map((await client.query(
    'SELECT employee_account,login_role,employee_name,department,active FROM access_control.employee_accounts',
  )).rows.map((row) => [row.employee_account, row]));
  const prepared = [];
  for (const employee of workbookInfo.employees) {
    const prior = existing.get(employee.account);
    if (prior) {
      prepared.push({ employee, existing: true, password: null, bundle: null, destination: null });
      continue;
    }
    const destination = path.join(credentialDir, `${employee.account}.tbcred`);
    if (await pathExists(destination)) throw new Error(`员工凭据文件已存在，拒绝覆盖：${destination}`);
    const roleExists = await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [employee.loginRole]);
    if (roleExists.rowCount) {
      throw new Error(`数据库角色 ${employee.loginRole} 已存在但不在员工登记表中；为避免生成错误凭据，已停止且不会修改该角色`);
    }
    const password = randomPassword();
    const bundle = await createReaderCredentialBundle({
      password,
      host: options.host,
      port: options.port,
      database: options.database,
      readerUser: employee.loginRole,
      employeeAccount: employee.account,
    });
    const temporary = path.join(credentialDir, `.pending-${employee.account}-${crypto.randomUUID()}.tbcred`);
    await fsp.writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await fsp.chmod(temporary, 0o600);
    prepared.push({ employee, existing: false, password, bundle: null, destination, temporary });
  }
  await client.query('BEGIN');
  try {
    for (const item of prepared) {
      const { employee } = item;
      await ensureRole(client, employee.departmentRole, { roleAdmin });
      if (!item.existing) await ensureRole(client, employee.loginRole, { login: true, password: item.password, roleAdmin });
      await grantManagedRole(client, BASE_ROLE, employee.loginRole, roleAdmin);
      await grantManagedRole(client, employee.departmentRole, employee.loginRole, roleAdmin);
      await client.query(`
        INSERT INTO access_control.employee_accounts(employee_account,login_role,employee_name,department,department_role,active,updated_at)
        VALUES($1,$2,$3,$4,$5,true,now())
        ON CONFLICT(employee_account) DO UPDATE SET employee_name=excluded.employee_name,department=excluded.department,
          department_role=excluded.department_role,active=true,updated_at=now()
      `, [employee.account, employee.loginRole, employee.name, employee.department, employee.departmentRole]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await Promise.all(prepared.map((entry) => entry.temporary && fsp.rm(entry.temporary, { force: true })));
    throw error;
  }
  const createdFiles = [];
  for (const item of prepared.filter((entry) => !entry.existing)) {
    await fsp.copyFile(item.temporary, item.destination, fsConstants.COPYFILE_EXCL);
    if (process.platform !== 'win32') await fsp.chmod(item.destination, 0o600);
    await fsp.rm(item.temporary, { force: true });
    createdFiles.push(item.destination);
  }
  return {
    access,
    selected: prepared.length,
    createdAccounts: prepared.filter((entry) => !entry.existing).map((entry) => entry.employee.account),
    existingAccounts: prepared.filter((entry) => entry.existing).map((entry) => entry.employee.account),
    credentialFiles: createdFiles,
    initialDatasetGrants: 0,
  };
}

export async function resolveAccessPrincipal(client, { account, department }) {
  if (Boolean(account) === Boolean(department)) throw new Error('必须且只能指定 --account 或 --department');
  if (account) {
    const result = await client.query('SELECT login_role FROM access_control.employee_accounts WHERE employee_account=$1 AND active', [normalizeEmployeeAccount(account)]);
    if (!result.rowCount) throw new Error(`找不到已开通的员工数据库账号：${account}`);
    return result.rows[0].login_role;
  }
  return departmentRoleName(department);
}

export async function changeEmployeeAccess(client, options) {
  const principal = await resolveAccessPrincipal(client, options);
  if (Boolean(options.dataset) === Boolean(options.table)) throw new Error('必须且只能指定 --dataset 或 --table');
  if (options.dataset) {
    const dataset = await client.query('SELECT dataset_key FROM meta.datasets WHERE dataset_key=$1 OR data_type || \'-\' || data_dimension=$1', [options.dataset]);
    if (dataset.rowCount !== 1) throw new Error(`找不到唯一的数据集：${options.dataset}`);
    if (options.revoke) {
      await client.query('DELETE FROM access_control.dataset_grants WHERE grantee_role=$1 AND dataset_key=$2', [principal, dataset.rows[0].dataset_key]);
    } else {
      await client.query('INSERT INTO access_control.dataset_grants(grantee_role,dataset_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [principal, dataset.rows[0].dataset_key]);
    }
    return { action: options.revoke ? 'revoked' : 'granted', principal, datasetKey: dataset.rows[0].dataset_key };
  }
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(options.table)) throw new Error('物理表必须使用安全的 schema.table 名称');
  const [schema, table] = options.table.split('.');
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const exists = await client.query('SELECT to_regclass($1) AS relation', [options.table]);
  if (!exists.rows[0].relation) throw new Error(`物理表不存在：${options.table}`);
  if (options.revoke) {
    await client.query(`REVOKE SELECT ON ${relation} FROM ${quoteIdentifier(principal)}`);
    await client.query('DELETE FROM access_control.table_grants WHERE grantee_role=$1 AND relation_name=$2', [principal, options.table]);
  } else {
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(principal)}`);
    await client.query(`GRANT SELECT ON ${relation} TO ${quoteIdentifier(principal)}`);
    await client.query('INSERT INTO access_control.table_grants(grantee_role,relation_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [principal, options.table]);
  }
  return { action: options.revoke ? 'revoked' : 'granted', principal, table: options.table };
}

export async function listEmployeeAccess(client) {
  const result = await client.query(`
    SELECT e.employee_account,e.login_role,e.employee_name,e.department,e.active,
      coalesce(array_agg(DISTINCT d.dataset_key) FILTER (WHERE d.dataset_key IS NOT NULL),'{}') AS datasets,
      coalesce(array_agg(DISTINCT t.relation_name) FILTER (WHERE t.relation_name IS NOT NULL),'{}') AS tables
    FROM access_control.employee_accounts e
    LEFT JOIN access_control.dataset_grants d ON d.grantee_role IN (e.login_role,e.department_role)
    LEFT JOIN access_control.table_grants t ON t.grantee_role IN (e.login_role,e.department_role)
    GROUP BY e.employee_account,e.login_role,e.employee_name,e.department,e.active
    ORDER BY e.employee_account
  `);
  return result.rows;
}

export async function listEmployeeAudit(client, { account, days = 90 } = {}) {
  const values = [Math.min(3650, Math.max(1, Number(days || 90)))];
  const where = [`a.queried_at >= now() - ($1::text || ' days')::interval`];
  if (account) { values.push(normalizeEmployeeAccount(account)); where.push(`e.employee_account=$${values.length}`); }
  const result = await client.query(`
    SELECT e.employee_account,e.employee_name,e.department,a.dataset_key,a.query_context,a.returned_rows,
      a.client_address::text,a.application_name,a.queried_at
    FROM access_control.query_audit a
    LEFT JOIN access_control.employee_accounts e ON e.login_role=a.employee_role
    WHERE ${where.join(' AND ')} ORDER BY a.queried_at DESC LIMIT 1000
  `, values);
  return result.rows;
}
