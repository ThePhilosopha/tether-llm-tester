const RAW_LIMIT = 10 * 1024 * 1024;

export function maskHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) =>
    /authorization|api[-_]?key|token/i.test(key) ? [key, '••••••••'] : [key, value]
  ));
}

export function parseSseFrame(frame) {
  const lines = frame.replace(/\r/g, '').split('\n');
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return { malformed: true, data }; }
}

export function eventFromChunk(chunk) {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};
  const toolCalls = (delta.tool_calls || []).map(call => ({
    index: call.index ?? 0,
    id: call.id,
    name: call.function?.name,
    arguments: call.function?.arguments || ''
  }));
  return {
    type: 'delta',
    text: delta.content || '',
    reasoning: delta.reasoning_content || delta.reasoning || '',
    toolCalls,
    finishReason: choice?.finish_reason || null,
    usage: chunk?.usage || null
  };
}

export async function forwardSse(upstream, send) {
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let truncated = false;
  for await (const bytes of upstream.body) {
    const text = decoder.decode(bytes, { stream: true });
    if (!truncated) {
      const remaining = RAW_LIMIT - raw.length;
      raw += text.slice(0, Math.max(0, remaining));
      truncated ||= text.length > remaining;
    }
    send({ type: 'raw', data: text });
    buffer += text;
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice((match.index ?? 0) + match[0].length);
      const parsed = parseSseFrame(frame);
      if (parsed) send(eventFromChunk(parsed));
    }
  }
  const tail = decoder.decode();
  if (tail) raw += tail.slice(0, Math.max(0, RAW_LIMIT - raw.length));
  send({ type: 'complete', raw, rawTruncated: truncated });
}
