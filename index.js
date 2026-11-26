import {createHash} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';

const reportTools = ['senpai_report_events', 'senpai-report_events', 'mcp__senpai__report_events'];

// R29: docs/attribution-rules.md#r29--gateway-request-cost-and-work
// Keep only local fingerprints of 32-unit runs. Long or unavailable histories use
// the fixed description. Bound the work and memory on a fleet machine.
function reportPrivacy() {
  const seen = new Map();
  let substitutions = 0;
  function* fingerprints(text) {
    for (let i = 0; i + 32 <= text.length; i++)
      yield createHash('sha256').update(text.slice(i, i + 32), 'utf16le').digest('base64');
  }
  function overlaps(hashes, text) {
    for (const hash of fingerprints(text)) if (hashes.has(hash)) return true;
    return false;
  }
  function begin(session, firstMessageID) {
    if (!session || seen.has(session)) return;
    if (seen.size >= 16) seen.delete(seen.keys().next().value);
    seen.set(session, {hashes:new Set(), firstMessageID});
  }
  function remember(session, texts) {
    const hashes = seen.get(session)?.hashes;
    if (!hashes) return;
    let remaining = 8192;
    for (const text of texts) {
      remaining -= typeof text === 'string' ? Math.max(1, text.length) : Infinity;
      if (remaining < 0) { seen.set(session, null); return; }
      for (const hash of fingerprints(text)) {
        hashes.add(hash);
        if (hashes.size > 8192) { seen.set(session, null); return; }
      }
    }
  }
  async function rememberAnswers(context, event, first) {
    let texts;
    try {
      const history = await context.session.context({sessionID:event.sessionID});
      if (Array.isArray(history) && history.length <= 128 && history[0]?.type === 'user' &&
          history[0].id === first && history.some(m => m.type === 'assistant' && m.id === event.messageID) &&
          history.every(m => m.type === 'user' || (m.type === 'assistant' && Array.isArray(m.content) && m.content.length <= 128))) {
        texts = history.filter(m => m.type === 'assistant').flatMap(m =>
          m.content.filter(part => part.type === 'text' || part.type === 'reasoning').map(part => part.text));
      }
    } catch {} // An unavailable snapshot takes the same bounded fallback.
    remember(event.sessionID, texts ?? [undefined]);
    return Boolean(texts);
  }
  function protect(session, tool, args, complete = true) {
    if (!args || !reportTools.includes(tool)) return args;
    const hashes = complete && seen.get(session)?.hashes;
    function replace(body, field, verb, ticket) {
      const text = body?.[field];
      if (typeof text !== 'string' || !text) return body;
      if (hashes && text.length <= 8192 && !overlaps(hashes, text)) return body;
      const target = typeof ticket === 'string' && /^#[1-9][0-9]{0,9}$/.test(ticket) ? ' on '+ticket : '';
      channel('senpai.opencode.report_substitutions').publish(++substitutions);
      return {...body, [field]: verb+' work'+target+'.'};
    }
    const c = args.c;
    const target = Array.isArray(c?.t) && c.t.length === 1 ? c.t[0] : null;
    const ticket = (!target?.k || target.k === 'w') && (!target?.r || target.r === 'w') ? target?.i : null;
    const action = c?.p === 's' ? 'Started' : c?.p === 'd' ? 'Finished' : 'Reported';
    const clean = replace(c, 'e', action, ticket);
    let next = clean === c ? args : {...args, c: clean};
    if (Array.isArray(args.events)) {
      const events = args.events.map(event => {
        const data = replace(event?.data, 'explanation', 'Reported');
        return data === event?.data ? event : {...event, data};
      });
      if (events.some((event, i) => event !== args.events[i])) next = {...next, events};
    }
    return next;
  }
  function before(event, check, run) {
    const first = seen.get(event.sessionID)?.firstMessageID;
    return first && reportTools.includes(event.tool) ? check(first).then(run, () => run(false)) : run(true);
  }
  return {begin, remember, rememberAnswers, before, protect};
}

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
    const privacy = reportPrivacy();
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
      event: async ({event}) => {
        const {info, part} = event.properties ?? {};
        if (event.type === 'session.created' && !info?.parentID) privacy.begin(info?.id, info?.id);
        if (event.type === 'message.part.updated' && part?.type === 'reasoning') privacy.remember(part.sessionID, [undefined]);
        if (event.type === 'session.error') privacy.remember(event.properties.sessionID, [undefined]);
      },
      'experimental.text.complete': async (input, output) => privacy.remember(input.sessionID, [output.text]),
      'chat.message': async (input, output) => {
        const parts = output.parts.filter(part => !part.synthetic);
        if (parts.length) {
          privacy.remember(input.sessionID, parts.map(part => part.type === 'text' ? part.text : undefined));
          turns.set(input.sessionID, output.message.id);
        }
      },
      'tool.execute.before': (input, output) => privacy.before(input, async () => {
        // V1 can call a tool during text and can finish reasoning without the text hook.
        const {data} = await context.client.session.messages({path:{id:input.sessionID}, query:{limit:1}});
        const msg = data?.at(-1);
        if (!Array.isArray(msg?.parts) || msg.parts.length > 128) return false;
        if (msg.parts.some(p => p.type === 'reasoning')) privacy.remember(input.sessionID, [undefined]);
        return msg.info?.role === 'assistant' && msg.parts.some(p => p.type === 'tool' && p.callID === input.callID) &&
          msg.parts.every(p => p.type !== 'text' || p.time?.end);
      }, complete => {
        const args = privacy.protect(input.sessionID, input.tool, output?.args, complete);
        if (args !== output?.args) Object.assign(output.args, args);
        send(options, input.sessionID, input.callID, input.tool, args, deliver, turns.get(input.sessionID));
      }),
    };
  },
  async setup(context) {
    const turns = new Map();
    const privacy = reportPrivacy();
    await context.session?.hook?.('prompt', async event => {
      const {sessionID, messageID} = event;
      const first = !turns.has(sessionID);
      turns.set(sessionID, messageID);
      if (first) {
        // The CLI may load the plug-in after creating the session. This hook runs
        // before the new message is stored. Only an empty native history is new.
        try {
          const info = await context.session.get({sessionID});
          if (info.id === sessionID && !info.parentID && !info.fork && !info.time?.busy && !info.time?.idle) {
            const history = await context.session.context({sessionID});
            if (Array.isArray(history) && !history.length && turns.get(sessionID) === messageID)
              privacy.begin(sessionID, messageID);
          }
        } catch {} // An unavailable history keeps the fixed action.
      }
      privacy.remember(sessionID, [event.prompt?.text]);
    });
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
    await context.tool.hook('execute.before', event => privacy.before(event,
      first => privacy.rememberAnswers(context, event, first), complete => {
        // OpenCode 2 freezes nested MCP arguments and accepts a replacement input.
        const args = privacy.protect(event.sessionID, event.tool, event.input, complete);
        if (args !== event.input) event.input = args;
        send(context.options, event.sessionID, event.id, event.tool, args, deliver, turns.get(event.sessionID));
      }));
  },
};
