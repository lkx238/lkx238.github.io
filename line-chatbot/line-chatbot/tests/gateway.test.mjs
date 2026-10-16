import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secret = 'test-channel-secret';
const calls = [];
let tempDir;
let mockServer;
let gateway;
let gatewayPort;
let mockPort;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function signature(body) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

async function waitForGateway(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Gateway exited before starting');
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Gateway did not start');
}

async function post(body, sig) {
  return fetch(`http://127.0.0.1:${gatewayPort}/line/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig ? { 'x-line-signature': sig } : {}) },
    body,
  });
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'line-bot-gateway-'));
  mockServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  mockPort = await listen(mockServer);

  const probe = createServer();
  gatewayPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  gateway = spawn(process.execPath, ['gateway/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      LINE_CHANNEL_SECRET: secret,
      N8N_WEBHOOK_URL: `http://127.0.0.1:${mockPort}/line-inbound`,
      DEDUPE_FILE: join(tempDir, 'dedupe.json'),
      MAX_BODY_BYTES: '2048',
    },
    stdio: 'ignore',
  });
  await waitForGateway(gateway);
});

after(async () => {
  if (gateway && gateway.exitCode === null) gateway.kill('SIGTERM');
  if (mockServer) await new Promise((resolve) => mockServer.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('accepts signed text events and removes user identity before forwarding', async () => {
  const event = {
    type: 'message',
    webhookEventId: 'evt-text-1',
    message: { type: 'text', id: 'msg-1', text: '你好' },
    replyToken: 'reply-token',
    source: { type: 'user', userId: 'user-secret' },
  };
  const body = JSON.stringify({ destination: 'Ubot', events: [event] });
  const response = await post(body, signature(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'accepted', eventCount: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].events[0], {
    type: 'message',
    webhookEventId: 'evt-text-1',
    message: { type: 'text', text: '你好' },
    replyToken: 'reply-token',
  });
  assert.equal('source' in calls[0].events[0], false, 'user identity is removed before forwarding');
});

test('rejects missing and invalid signatures', async () => {
  const body = JSON.stringify({ events: [] });
  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, 'not-a-real-signature')).status, 401);
});

test('ignores stickers and other non-text events', async () => {
  const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'sticker-1', message: { type: 'sticker' } }] });
  const response = await post(body, signature(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ignored' });
  assert.equal(calls.length, 1);
});

test('does not forward a duplicate webhook event', async () => {
  const event = { type: 'message', webhookEventId: 'evt-dedup-1', message: { type: 'text', text: '再見' }, replyToken: 'reply-2' };
  const body = JSON.stringify({ events: [event] });
  assert.equal((await post(body, signature(body))).status, 200);
  const duplicate = await post(body, signature(body));
  assert.deepEqual(await duplicate.json(), { status: 'ignored' });
  assert.equal(calls.length, 2);
});

test('rejects bodies above the configured limit', async () => {
  const body = JSON.stringify({ text: 'x'.repeat(3000) });
  const response = await post(body, signature(body));
  assert.equal(response.status, 413);
});
