import {createHash, randomUUID} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';

const reportTools = ['senpai_report_events', 'senpai-report_events', 'mcp__senpai__report_events'];

// The two report formats share the fix and reference records in crates/contracts.
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const oneOf = (...values) => value => values.includes(value);
const listOf = (check, limit) => value => Array.isArray(value) && value.length <= limit && value.every(check);
const shortIndex = value => Number.isInteger(value) && value >= 0 && value <= 255;
const text = (value, limit = 500) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit &&
  !/[\p{Cc}]|bearer |authorization:|(?:senpai_(?:org|native)_|sk-)[0-9a-f]{64}|sk-ant-|sk-proj-|ghp_|github_pat_|password=|api_key=|access_token=|:\/\/[^/]*@/iu.test(value);
function fields(value, required, rules) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key) && value[key] != null) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(rules, key) &&
      (item === null ? !required.includes(key) : rules[key](item)));
}
function validReport(args, unsafe) {
  const identifier = value => text(value, 1024) && /^[^\s]+$/.test(value) &&
    (/^#[1-9]\d*$|^(?:repo:)?\d+$|^[A-Z][A-Z0-9_]*-[1-9]\d*$|^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) || uuid(value.replace(/^source-/, '')) || !unsafe(value));
  const kind = oneOf('w','p','work_item','pull_request','repository','commit','crm_record','ci_run',
    'ci_attempt','ci_job','build','artifact','artifact_location','deployment','environment');
  const reference = value => fields(value, ['source_instance_id','native_id'], {
    source_instance_id:identifier, parent_scope:identifier, native_namespace:identifier, native_id:identifier,
    object_type:kind, kind, role:oneOf('work','context','introduced_by')}) && Boolean(value.object_type) !== Boolean(value.kind);
  const oid = value => fields(value, ['algorithm','value'], {algorithm:oneOf('sha1','sha256'),
    value:v => typeof v === 'string' && /^[0-9a-f]+$/.test(v)}) &&
    value.value.length === (value.algorithm === 'sha1' ? 40 : 64);
  const updates = listOf(v => fields(v, ['repository','destination_id','ref_name','status'], {
    repository:reference, destination_id:identifier, ref_name:n => identifier(n) && n.startsWith('refs/'),
    old_oid:oid, new_oid:oid, status:oneOf('proposed','accepted','up_to_date','rejected','unknown')}), 64);
  // The service accepts these historical spellings only on legacy event batches.
  const legacyFix = {exposure:oneOf('branch','shipped','unknown','pr','unmerged','production','deployed','live','released'),
    introduced_by:value => text(value, 1024) && identifier(value.trim().replace(/^PR (?=#[1-9]\d*$)/, ''))};
  const fix = (v, legacy = false) => fields(v, ['kind'], {kind:oneOf('feature','bug_repair','refactor','requirement_change','other'),
    defect_id:text, defect_label:text, evidence_locator:text, origin_unknown_reason:text,
    mixed_scope:b => typeof b === 'boolean', exposure:oneOf('branch','shipped','unknown'), ...(legacy && legacyFix)});
  const disposition = oneOf('later','unrelated');
  const name = v => typeof v === 'string'; // Invalid names and copied explanations are replaced below.
  const category = v => text(v, 200);
  function command(c) {
    if (c?.p === '?') return fields(c, ['p'], {p:oneOf('?')});
    const run = v => validWorkHandle(v, false);
    if (c?.p === 'n') return fields(c, ['p'], {p:oneOf('n'), r:run, q:run});
    if (c?.p === 'a') return fields(c, ['p','w','b'], {p:oneOf('a'), w:validWorkHandle, b:uuid});
    const grant = g => typeof g === 'string' ? /^[0-9a-f]{8}$/.test(g) :
      Array.isArray(g) && g.length === 2 && identifier(g[0]) && (g[1] === null || identifier(g[1]));
    const targets = listOf(v => v?.g !== null && fields(v,['i'], {i:identifier, g:grant, n:identifier, k:kind,
      r:oneOf('w','c','i','work','context','introduced_by')}), 32);
    return fields(c, c?.p === 's' ? ['p','w','t','f'] : ['p','w','x'], {
      p:oneOf('s','d'), w:validWorkHandle, t:targets, f:fix, o:name, e:text, k:category, r:updates,
      pt:shortIndex, pd:disposition, ...(c?.p === 'd' && {x:oneOf('s','p','f','c','u','n')})});
  }
  function event(v) {
    const data = d => fields(d, ['schema_version','action_id','session_id','phase','operation','coverage','evidence','reason_codes'], {
      schema_version:oneOf('1.0'), action_id:uuid, session_id:s => typeof s === 'string' &&
        s.startsWith('senpai.reporting-context.v1:') && uuid(s.slice('senpai.reporting-context.v1:'.length)),
      phase:oneOf('intent','result'), operation:name, evidence:oneOf('agent_report'), coverage:oneOf('degraded'),
      reason_codes:listOf(oneOf('native_identity_unavailable','reporting_context_time_used'), 16),
      targets:listOf(reference, 32), primary_target:shortIndex, target_disposition:disposition, ref_updates:updates,
      explanation:text, category_hint:category, fix:value => fix(value, true),
      execution_outcome:oneOf('succeeded','partially_succeeded','failed','cancelled','outcome_unknown','no_change',
        'success','completed','partial','failure','canceled','unknown')}) &&
      (d.phase === 'result') === (d.execution_outcome != null) &&
      ['native_identity_unavailable','reporting_context_time_used'].every(code => d.reason_codes.includes(code));
    return fields(v, ['specversion','id','source','type','time','datacontenttype','data'], {
      specversion:oneOf('1.0'), id:uuid, source:s => typeof s === 'string' && s.startsWith('urn:senpai:producer:') &&
        uuid(s.slice('urn:senpai:producer:'.length)), type:oneOf('ai.senpai.action.observed.v1'),
      time:t => typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(t) &&
        Number.isFinite(Date.parse(t)), datacontenttype:oneOf('application/json'), data});
  }
  if (args && (args.compact_ack === null || args.events === null)) return false;
  return fields(args, args?.c == null ? ['events'] : ['c'], {c:command,
    events:listOf(event, 100), compact_ack:b => typeof b === 'boolean'}) &&
    (args.c == null ? args.events.length > 0 : !args.events?.length);
}

// R29: docs/attribution-rules.md#r29--gateway-request-cost-and-work
function reportPrivacy() {
  const seen = new Map();
  let substitutions = 0;
  function* fingerprints(text, width) {
    for (let i = 0; i + width <= text.length; i++)
      yield createHash('sha256').update(text.slice(i, i + width), 'utf16le').digest('base64');
  }
  function begin(session, firstMessageID) {
    if (!session || seen.has(session)) return;
    if (seen.size >= 16) seen.delete(seen.keys().next().value);
    seen.set(session, {hashes:new Set(), widths:new Set(), firstMessageID});
  }
  function remember(session, texts) {
    const state = seen.get(session);
    if (!state) return;
    let remaining = 8192;
    for (const text of texts) {
      remaining -= typeof text === 'string' ? Math.max(1, text.length) : Infinity;
      if (remaining < 0) { seen.set(session, null); return; }
      const trimmed = text.trim();
      const samples = trimmed && trimmed !== text && trimmed.length < 32 ? [text, trimmed] : [text];
      for (const sample of samples) {
        const width = Math.min(32, sample.length);
        if (!width) continue;
        state.widths.add(width);
        for (const hash of fingerprints(sample, width)) {
          state.hashes.add(hash);
          if (state.hashes.size > 8192) { seen.set(session, null); return; }
        }
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
    if (!reportTools.includes(tool)) return args;
    if (typeof args?.c === 'string') throw new Error('Send the command as an object to submit this report.');
    const state = complete && seen.get(session);
    function unsafe(text) {
      if (typeof text !== 'string' || !text) return false;
      if (!state || text.length * Math.max(1, state.widths.size) > 8192) return true;
      for (const width of state.widths)
        for (const hash of fingerprints(text, width)) if (state.hashes.has(hash)) return true;
      return false;
    }
    if (!validReport(args, unsafe)) throw new Error('SenpAI kept this call on the computer. Check the report format.');
    function replace(body, field, fix, category, verb, ticket) {
      const prose = ['origin_unknown_reason','defect_label','evidence_locator'];
      if (typeof fix?.defect_id === 'string' && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(fix.defect_id)) prose.push('defect_id');
      const blocked = prose.find(name => unsafe(fix?.[name])) || (unsafe(body?.[category]) && 'category_hint');
      if (blocked) throw new Error('SenpAI kept this report on the computer. Supply independent metadata for '+blocked+'.');
      const operation = field === 'e' ? 'o' : 'operation';
      const {[operation]: name, ...rest} = body;
      let result = body;
      if (name !== undefined && (!text(name, 100) || !/^[a-z0-9._-]+$/.test(name) || unsafe(name)))
        result = operation === 'o' ? rest : {...rest, operation:'your-short-task-name'};
      if (unsafe(body[field])) {
        const target = typeof ticket === 'string' && /^#[1-9][0-9]{0,9}$/.test(ticket) ? ' on '+ticket : '';
        result = {...result, [field]:verb+' work'+target+'.'};
      }
      if (result !== body) channel('senpai.opencode.report_substitutions').publish(++substitutions);
      return result;
    }
    const c = args.c;
    const target = Array.isArray(c?.t) && c.t.length === 1 ? c.t[0] : null;
    const ticket = (!target?.k || target.k === 'w') && (!target?.r || target.r === 'w') ? target?.i : null;
    const action = c?.p === 's' ? 'Started' : c?.p === 'd' ? 'Finished' : 'Reported';
    const next = {...args};
    if (c) next.c = replace(c, 'e', c.f, 'k', action, ticket);
    if (Array.isArray(args.events)) next.events = args.events.map(event => event?.data
      ? {...event, data:replace(event.data, 'explanation', event.data.fix, 'category_hint', 'Reported')} : event);
    return next;
  }
  function before(event, check, run) {
    const first = seen.get(event.sessionID)?.firstMessageID;
    return first && reportTools.includes(event.tool) ? check(first).then(run, () => run(false)) : run(true);
  }
  return {begin, remember, rememberAnswers, before, protect};
}

function post(options, body, onReply) {
  if (typeof options?.endpoint !== 'string' || !options.endpoint ||
      typeof options?.token !== 'string' || !options.token) return;
  try {
    void fetch(options.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${options.token}`},
      body: JSON.stringify(body),
    }).then(response => response.ok && onReply ? response.json().then(onReply) : response.body?.cancel()).catch(() => {});
  } catch {}
}

// R19: docs/attribution-rules.md#r19--incremental-accounting-preserves-request-history
function validWorkHandle(value, work = true) {
  if (typeof value !== 'string' || value.length !== 22) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === value &&
    (work ? (bytes[6] >> 4) === 7 && (bytes[8] & 0xc0) === 0x80 : bytes.some(byte => byte !== 0));
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
    const attempt = {session, request_key: randomUUID()};
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
    pending += chunk ? decoder.decode(chunk.subarray(0, remaining), {stream:true}) : decoder.decode();
    remaining = Math.max(0, remaining - (chunk?.byteLength ?? 0));
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
        // Before the new message is stored, an empty history identifies a new session even after late plug-in loading.
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
