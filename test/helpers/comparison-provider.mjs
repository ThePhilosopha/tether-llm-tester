import { createServer } from 'node:http';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function reply(res, request) {
  if (res.destroyed || res.writableEnded) return;
  if (request.body.model === 'fail') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock unavailable' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    `data: ${JSON.stringify({ choices: [{ delta: { content: `reply:${request.body.model}` } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`,
    'data: [DONE]\n\n'
  ].join(''));
}

export async function startMockProvider() {
  const requests = [];
  const pending = [];
  let held = true;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'side-a', supported_parameters: ['temperature', 'top_p', 'max_tokens'] },
        { id: 'side-b', supported_parameters: ['temperature', 'top_p', 'max_tokens'] },
        { id: 'fail', supported_parameters: ['temperature', 'top_p', 'max_tokens'] }
      ] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readJson(req);
      const entry = { method: req.method, url: req.url, headers: req.headers, body, res };
      requests.push(entry);
      if (held) pending.push(entry);
      else reply(res, entry);
    } catch (error) {
      res.writeHead(400).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    hold() { held = true; },
    release() { held = false; for (const request of pending.splice(0)) reply(request.res, request); },
    async close() {
      for (const request of pending.splice(0)) reply(request.res, request);
      await new Promise(resolve => server.close(resolve));
    }
  };
}
