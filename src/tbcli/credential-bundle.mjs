import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const READER_CREDENTIAL_BUNDLE_FORMAT = 'tbcli-reader-credential';
export const READER_CREDENTIAL_BUNDLE_VERSION = 1;
const APPLICATION_CONTEXT = 'tbcli portable company reader credential bundle v1';

function deriveKey(salt) {
  return crypto.scryptSync(APPLICATION_CONTEXT, salt, 32);
}

function parsePgpassLine(line) {
  const values = [];
  let current = '';
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') escaped = true;
    else if (char === ':') {
      values.push(current);
      current = '';
    } else current += char;
  }
  values.push(current);
  return values;
}

function escapePgpassValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

function validatePayload(payload) {
  if (!payload || payload.version !== 1 || payload.accessMode !== 'read-only') {
    throw new Error('只读凭证文件内容无效或版本不受支持');
  }
  for (const key of ['host', 'database', 'readerUser', 'password']) {
    if (typeof payload[key] !== 'string' || !payload[key]) throw new Error(`只读凭证文件缺少 ${key}`);
  }
  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('只读凭证文件端口无效');
  if (payload.employeeAccount !== undefined
    && !/^[a-z][a-z0-9]{1,24}$/.test(String(payload.employeeAccount))) {
    throw new Error('只读凭证文件 employeeAccount 无效');
  }
  return { ...payload, port, ...(payload.employeeAudit === true ? { employeeAudit: true } : {}) };
}

export async function createReaderCredentialBundle({ pgpassFile, password, host, port = 5432, database, readerUser, employeeAccount }) {
  for (const [key, value] of Object.entries({ host, database, readerUser })) {
    if (!value) throw new Error(`创建只读凭证文件缺少 ${key}`);
  }
  let selectedPassword = password;
  if (selectedPassword === undefined) {
    if (!pgpassFile) throw new Error('创建只读凭证文件缺少 pgpassFile 或 password');
    const lines = (await fsp.readFile(path.resolve(pgpassFile), 'utf8')).split(/\r?\n/);
    const matches = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const [entryHost, entryPort, entryDatabase, entryUser, entryPassword] = parsePgpassLine(line);
      if (entryPassword !== undefined
        && entryHost === String(host)
        && entryPort === String(port)
        && entryDatabase === String(database)
        && entryUser === String(readerUser)) matches.push(entryPassword);
    }
    if (matches.length !== 1) {
      throw new Error(`密码文件中必须且只能有一条完全匹配 ${readerUser}@${host}:${port}/${database} 的只读凭据`);
    }
    [selectedPassword] = matches;
  }
  if (typeof selectedPassword !== 'string' || !selectedPassword) throw new Error('只读密码不能为空');

  const payload = validatePayload({
    version: 1,
    accessMode: 'read-only',
    host: String(host),
    port: Number(port),
    database: String(database),
    readerUser: String(readerUser),
    password: selectedPassword,
    ...(employeeAccount ? { employeeAccount: String(employeeAccount), employeeAudit: true } : {}),
  });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  cipher.setAAD(Buffer.from(`${READER_CREDENTIAL_BUNDLE_FORMAT}:${READER_CREDENTIAL_BUNDLE_VERSION}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: READER_CREDENTIAL_BUNDLE_FORMAT,
    version: READER_CREDENTIAL_BUNDLE_VERSION,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptReaderCredentialBundle(bundle) {
  if (!bundle || bundle.format !== READER_CREDENTIAL_BUNDLE_FORMAT
    || bundle.version !== READER_CREDENTIAL_BUNDLE_VERSION
    || bundle.cipher !== 'aes-256-gcm'
    || bundle.kdf !== 'scrypt') throw new Error('不是受支持的 tbcli 只读凭证文件');
  try {
    const salt = Buffer.from(bundle.salt, 'base64');
    const iv = Buffer.from(bundle.iv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
    decipher.setAAD(Buffer.from(`${READER_CREDENTIAL_BUNDLE_FORMAT}:${READER_CREDENTIAL_BUNDLE_VERSION}`));
    decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return validatePayload(JSON.parse(plaintext));
  } catch (error) {
    if (/只读凭证文件/.test(error.message)) throw error;
    throw new Error('只读凭证文件损坏、被修改或无法解密');
  }
}

export async function readReaderCredentialBundle(file) {
  const resolved = path.resolve(file);
  const raw = JSON.parse(await fsp.readFile(resolved, 'utf8'));
  return { bundlePath: resolved, payload: decryptReaderCredentialBundle(raw) };
}

export function serializeReaderPgpass(payload) {
  return `${[payload.host, payload.port, payload.database, payload.readerUser, payload.password]
    .map(escapePgpassValue).join(':')}\n`;
}
