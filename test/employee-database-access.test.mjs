import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import {
  departmentRoleName,
  employeeRoleName,
  readEnabledEmployeesFromWorkbook,
} from '../src/tbcli/employee-database-access.mjs';
import { createReaderCredentialBundle, decryptReaderCredentialBundle } from '../src/tbcli/credential-bundle.mjs';

test('employee role names are deterministic and reject unsafe account names', () => {
  assert.equal(employeeRoleName('wuxy'), 'tb_emp_wuxy');
  assert.equal(departmentRoleName('运营'), 'tb_dept_ops');
  assert.throws(() => employeeRoleName('吴晓燕'), /小写字母和数字/);
});

test('employee workbook reader selects only database-enabled rows and never consumes NAS passwords', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tbcli-employee-workbook-'));
  const file = path.join(dir, 'employees.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('员工账号');
  sheet.addRow(['管理员专用']);
  sheet.addRow([]);
  sheet.addRow(['员工名称', '部门', '账号名称', '新初始密码', '数据库开通']);
  sheet.addRow(['吴晓燕', '运营', 'wuxy', 'NAS-secret-must-not-be-used', '是']);
  sheet.addRow(['其他员工', '设计', 'other', 'another-secret', '否']);
  await workbook.xlsx.writeFile(file);
  const result = await readEnabledEmployeesFromWorkbook(file);
  assert.deepEqual(result.employees, [{
    name: '吴晓燕', department: '运营', account: 'wuxy',
    loginRole: 'tb_emp_wuxy', departmentRole: 'tb_dept_ops',
  }]);
  assert.doesNotMatch(JSON.stringify(result), /secret/i);
});

test('employee credential bundle carries audit identity without exposing its password', async () => {
  const bundle = await createReaderCredentialBundle({
    password: 'generated-database-password', host: 'nas-data', port: 15432,
    database: 'commerce_analytics', readerUser: 'tb_emp_wuxy', employeeAccount: 'wuxy',
  });
  assert.doesNotMatch(JSON.stringify(bundle), /generated-database-password/);
  const payload = decryptReaderCredentialBundle(bundle);
  assert.equal(payload.employeeAccount, 'wuxy');
  assert.equal(payload.employeeAudit, true);
  assert.equal(payload.readerUser, 'tb_emp_wuxy');
});
