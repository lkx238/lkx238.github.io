import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 3000);
const channelSecret = process.env.LINE_CHANNEL_SECRET || '';
const upstreamUrl = process.env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/line-inbound';
const dedupeFile = process.env.DEDUPE_FILE || './.data/processed-events.json';
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 1_048_576);
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 5_000);
const processed = new Map();
const inFlight = new Set();

async function loadProcessed() {
  try {
    const data = JSON.parse(await readFile(dedupeFile, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, timestamp] of Object.entries(data)) {
      if (Number(timestamp) >= cutoff) processed.set(id, Number(timestamp));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function saveProcessed() {
  await mkdir(dirname(dedupeFile), { recursive: true });
  const tempFile = `${dedupeFile}.tmp`;
  await writeFile(tempFile, JSON.stringify(Object.fromEntries(processed)), { mode: 0o600 });
  await rename(tempFile, dedupeFile);
}

function reply(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function hasValidSignature(rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function handleWebhook(req, res) {
  if (!channelSecret) return reply(res, 503, { error: 'LINE_CHANNEL_SECRET is not configured' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return reply(res, error.status || 400, { error: error.status === 413 ? 'body_too_large' : 'invalid_body' });
  }

  if (!hasValidSignature(rawBody, req.headers['x-line-signature'])) {
    return reply(res, 401, { error: 'invalid_signature' });
  }

  let webhook;
  try {
    webhook = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return reply(res, 400, { error: 'invalid_json' });
  }

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of processed) if (timestamp < cutoff) processed.delete(id);

  const events = (Array.isArray(webhook.events) ? webhook.events : []).filter((event) => {
    if (event?.type !== 'message' || event?.message?.type !== 'text' || typeof event.message.text !== 'string') return false;
    const id = event.webhookEventId;
    return !id || (!processed.has(id) && !inFlight.has(id));
  }).map((event) => ({
    type: 'message',
    ...(event.webhookEventId ? { webhookEventId: event.webhookEventId } : {}),
    message: { type: 'text', text: event.message.text },
    replyToken: event.replyToken,
  }));

  if (events.length === 0) return reply(res, 200, { status: 'ignored' });
  for (const event of events) if (event.webhookEventId) inFlight.add(event.webhookEventId);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination: webhook.destination, events }),
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    });
    if (!upstream.ok) {
      for (const event of events) if (event.webhookEventId) inFlight.delete(event.webhookEventId);
      return reply(res, 502, { error: 'workflow_unavailable' });
    }

    for (const event of events) {
      if (event.webhookEventId) {
        inFlight.delete(event.webhookEventId);
        processed.set(event.webhookEventId, now);
      }
    }
    await saveProcessed();
    return reply(res, 200, { status: 'accepted', eventCount: events.length });
  } catch {
    for (const event of events) if (event.webhookEventId) inFlight.delete(event.webhookEventId);
    return reply(res, 502, { error: 'workflow_unavailable' });
  }
}

await loadProcessed();

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { status: 'ok' });
  if (req.method === 'POST' && path === '/line/webhook') return handleWebhook(req, res);
  return reply(res, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`line-gateway listening on ${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
