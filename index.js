const reportTools = ['senpai_report_events', 'senpai-report_events', 'mcp__senpai__report_events'];

function send(options, session, step, tool, args, deliver, turn) {
  if (typeof options?.endpoint !== 'string' || !options.endpoint ||
      typeof options?.token !== 'string' || !options.token) return;
  if ([session, step, tool].some(value => typeof value !== 'string' || !value)) return;
  // Fail open: never wait for the network or stop the developer; no retry or queue.
  try {
    const body = {session_id: session, tool_call_id: step, tool_name: tool};
    if (typeof turn === 'string' && turn) body.turn_id = turn;
    const handle = args?.c?.w;
    if (reportTools.includes(tool) && typeof handle === 'string' && handle.length <= 64)
      body.reporting = {work_handle: handle};
    void fetch(options.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${options.token}`},
      body: JSON.stringify(body),
    }).then(async response => {
      if (!response.ok) return response.body?.cancel();
      const answer = await response.json();
      const hook = answer?.hookSpecificOutput;
      // R24: docs/attribution-rules.md#r24--missing-report-spans
      // The server decides; the client only passes its text to the native session.
      if (hook?.hookEventName === 'PreToolUse' && typeof hook.additionalContext === 'string' && hook.additionalContext)
        await deliver(session, hook.additionalContext);
    }).catch(() => {});
  } catch {}
}

export default {
  id: 'senpai',
  async server(context, options) {
    const turns = new Map();
    const deliver = (session, text) => context.client.session.prompt({path: {id: session},
      body: {noReply: true, parts: [{type: 'text', text, synthetic: true}]}});
    return {
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
    const deliver = (sessionID, text) => context.session.synthetic({sessionID, text,
      description: 'SenpAI reporting reminder', resume: false});
    await context.tool.hook('execute.before', event => {
      send(context.options, event.sessionID, event.id, event.tool, event.input, deliver, turns.get(event.sessionID));
    });
  },
};
