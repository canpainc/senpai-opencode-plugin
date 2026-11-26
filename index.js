const reportTools = ['senpai_report_events', 'senpai-report_events', 'mcp__senpai__report_events'];

// One address and credential from the issued settings. No queue or private retry.
function post(options, body, onReply) {
  if (typeof options?.endpoint !== 'string' || !options.endpoint ||
      typeof options.token !== 'string' || !options.token) return;
  try {
    void fetch(options.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${options.token}`},
      body: JSON.stringify(body),
    }).then(response => response.ok && onReply ? response.json().then(onReply) : response.body?.cancel()).catch(() => {});
  } catch {}
}

// R19: docs/attribution-rules.md#r19--incremental-accounting-preserves-request-history
function validWorkHandle(value) {
  if (typeof value !== 'string' || value.length !== 22) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === value &&
    (bytes[6] >> 4) === 7 && (bytes[8] & 0xc0) === 0x80;
}

function send(options, session, step, tool, args, deliver, turn) {
  if ([session, step, tool].some(value => typeof value !== 'string' || !value)) return;
  const body = {session_id: session, tool_call_id: step, tool_name: tool};
  if (typeof turn === 'string' && turn) body.turn_id = turn;
  const handle = args?.c?.w;
  if (reportTools.includes(tool) && validWorkHandle(handle))
    body.reporting = {work_handle: handle};
  post(options, body, answer => {
    const hook = answer?.hookSpecificOutput;
    // R24: docs/attribution-rules.md#r24--missing-report-spans
    if (hook?.hookEventName === 'PreToolUse' && typeof hook.additionalContext === 'string' && hook.additionalContext)
      return deliver(session, hook.additionalContext);
  });
}

// R29: docs/attribution-rules.md#r29--gateway-request-cost-and-work
function startAttempt(options, session, url, method) {
  if (method !== 'POST' || typeof session !== 'string' || !/^ses_[A-Za-z0-9_-]{1,196}$/.test(session)) return;
  try {
    if (!/\/(?:chat\/completions|messages|responses)\/?$/.test(new URL(url).pathname)) return;
    const attempt = {session, request_key: crypto.randomUUID()};
    post(options, attempt);
    return attempt;
  } catch {}
}

// A large JSON response can have complete top-level fields before the inspection limit.
function completeFields(text) {
  let depth = 0, quoted = false, lastComma = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) return text.slice(0, i + 1);
    } else if (c === ',' && depth === 1) lastComma = i;
  }
  return lastComma < 0 ? '' : text.slice(0, lastComma) + '}';
}

function observeResponse(options, attempt, response) {
  if (!attempt || !response?.ok || !response.body || response.bodyUsed || response.body.locked) return response;
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (type !== 'text/event-stream' && type !== 'application/json') return response;
  // Inspect a bounded prefix as the caller reads. Never clone or drain the response.
  const decoder = new TextDecoder();
  let pending = '', remaining = 32768;
  function inspect(chunk) {
    if (!remaining) return;
    const size = chunk?.byteLength ?? 0;
    pending += chunk ? decoder.decode(chunk.subarray(0, remaining), {stream:true}) : decoder.decode();
    remaining = Math.max(0, remaining - size);
    if (type === 'application/json' && chunk && remaining) return;
    const events = type === 'text/event-stream' ? pending.split(/\r?\n\r?\n/) : [chunk ? completeFields(pending) : pending];
    if (type === 'text/event-stream') pending = events.pop();
    for (const event of events) {
      const data = type === 'application/json' ? event : event.split(/\r?\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let item;
      try { item = JSON.parse(data); } catch { continue; }
      const id = item?.type === 'message_start' ? item.message?.id :
        item?.type === 'response.created' ? item.response?.id : item?.id;
      if (typeof id === 'string' && /^(?:chatcmpl-|msg_|resp_)[A-Za-z0-9_-]{12,160}$/.test(id)) {
        post(options, {...attempt, response_id:id});
        remaining = 0;
        break;
      }
    }
    if (!remaining) pending = '';
  }
  function safeInspect(chunk) {
    try { inspect(chunk); } catch { remaining = 0; pending = ''; }
  }
  const result = new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) { controller.enqueue(chunk); safeInspect(chunk); },
    flush() { safeInspect(); },
  })), response);
  for (const key of ['url','redirected','type']) Object.defineProperty(result, key, {value:response[key]});
  return result;
}

export default {
  id: 'senpai',
  async server(context, options) {
    const turns = new Map();
    const deliver = (session, text) => context.client.session.prompt({path: {id: session},
      body: {noReply: true, parts: [{type: 'text', text, synthetic: true}]}});
    const wrapped = new WeakSet();
    return {
      ...(options?.modelAttempts === true && {config: async config => {
        for (const provider of Object.values(config.provider ?? {})) {
          const settings = provider?.options;
          if (!settings?.baseURL || wrapped.has(settings.fetch)) continue;
          const delegate = settings.fetch ?? fetch;
          settings.fetch = async (input, init) => {
            let attempt;
            try {
              const headers = new Headers(init?.headers ?? input?.headers);
              attempt = startAttempt(options, headers.get('x-opencode-session-id') ?? headers.get('x-session-id'),
                input?.url ?? input, init?.method ?? input?.method);
            } catch {}
            const response = await delegate(input, init);
            return observeResponse(options, attempt, response);
          };
          wrapped.add(settings.fetch);
        }
      }}),
      'chat.message': async (input, output) => {
        if (output.parts.some(part => !part.synthetic)) turns.set(input.sessionID, output.message.id);
      },
      'tool.execute.before': (input, output) => send(options, input.sessionID, input.callID,
        input.tool, output?.args, deliver, turns.get(input.sessionID)),
    };
  },
  async setup(context) {
    const turns = new Map();
    await context.session?.hook?.('prompt', event => {turns.set(event.sessionID, event.messageID);});
    if (context.options?.modelAttempts === true) {
      const attempts = new WeakMap();
      await context.session.hook('http.request', event => {
        const attempt = startAttempt(context.options, event.sessionID, event.request.url, event.request.method);
        if (attempt) attempts.set(event.request, attempt);
      });
      await context.session.hook('http.response', event => {
        event.response = observeResponse(context.options, attempts.get(event.request), event.response);
      });
    }
    const deliver = (sessionID, text) => context.session.synthetic({sessionID, text,
      description: 'SenpAI reporting reminder', resume: false});
    await context.tool.hook('execute.before', event => {
      send(context.options, event.sessionID, event.id, event.tool, event.input, deliver, turns.get(event.sessionID));
    });
  },
};
