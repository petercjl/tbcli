import assert from 'node:assert/strict';
import test from 'node:test';

import { businessCapabilities, COMMAND_DEFINITIONS } from '../src/tbcli/command-registry.mjs';
import { ROUTED_COMMAND_KEYS } from '../src/tbcli/cli.mjs';

test('every routed command is declared in the single command registry', () => {
  assert.deepEqual(
    [...ROUTED_COMMAND_KEYS].sort(),
    COMMAND_DEFINITIONS.map((entry) => entry.key).sort(),
  );
});

test('authentication commands are stable internal capabilities', () => {
  for (const key of ['auth login', 'auth status']) {
    const command = COMMAND_DEFINITIONS.find((entry) => entry.key === key);
    assert.equal(command?.maturity, 'stable');
    assert.equal(command?.audience, 'internal');
  }
});

test('version command is a stable internal capability', () => {
  const command = COMMAND_DEFINITIONS.find((entry) => entry.key === 'version');
  assert.equal(command?.maturity, 'stable');
  assert.equal(command?.audience, 'internal');
});

test('direct SYCM fetch advertises its date granularity option', () => {
  const command = COMMAND_DEFINITIONS.find((entry) => entry.key === 'sycm fetch');
  assert.match(command.capability.commandTemplate, /--date-type/);
  assert.match(command.capability.commandTemplate, /--all-history/);
  assert.match(command.capability.commandTemplate, /--item-ids/);
  assert.match(command.capability.commandTemplate, /--device/);
});

test('every stable business command has complete ecommerce-facing guidance', () => {
  const capabilities = businessCapabilities();
  assert.ok(capabilities.length > 0);
  for (const entry of capabilities) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    for (const field of ['name', 'description', 'examplePrompt', 'delivery', 'commandTemplate']) {
      assert.equal(typeof entry[field], 'string', `${entry.command}.${field}`);
      assert.ok(entry[field].trim(), `${entry.command}.${field}`);
    }
    assert.ok(Array.isArray(entry.requiredInputs) && entry.requiredInputs.length > 0);
    assert.ok(Array.isArray(entry.optionalInputs));
    assert.doesNotMatch(
      `${entry.name} ${entry.description} ${entry.examplePrompt} ${entry.delivery}`,
      /API|CDP|selector|拦截|解密|解码/i,
    );
  }
});

test('shop product capability uses the agreed ecommerce prompt', () => {
  const capability = businessCapabilities().find((entry) => entry.command === 'shop products');
  assert.equal(capability.examplePrompt, '帮我获取【店铺首页链接】的商品列表');
});

test('DingTalk document capability is discoverable without implementation details', () => {
  const capability = businessCapabilities().find((entry) => entry.command === 'document get');
  assert.equal(capability.examplePrompt, '帮我读取【钉钉文档链接】的完整图文内容');
  assert.match(capability.delivery, /Markdown/);
  assert.doesNotMatch(`${capability.name} ${capability.description}`, /CDP|API|拦截/i);
});

test('DingTalk document tree capability is discoverable for batch reading', () => {
  const capability = businessCapabilities().find((item) => item.id === 'dingtalk-document-tree');
  assert.ok(capability);
  assert.equal(capability.examplePrompt, '帮我盘点【钉钉知识库目录链接】下面的所有文档');
  assert.match(capability.delivery, /JSON 目录树/);
  assert.doesNotMatch(JSON.stringify(capability), /CDP|API|接口|调试端口/i);
});
