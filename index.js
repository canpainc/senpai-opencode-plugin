const reportTools = ['senpai_report_events', 'senpai-report_events', 'mcp__senpai__report_events'];

function send(options, session, step, tool, args) {
  if (typeof options?.endpoint !== 'string' || !options.endpoint ||
      typeof options?.token !== 'string' || !options.token) return;
  if ([session, step, tool].some(value => typeof value !== 'string' || !value)) return;
  // Fail open: never wait for the network or stop the developer; no retry or queue.
  try {
    const body = {session_id: session, tool_call_id: step, tool_name: tool};
    const handle = args?.c?.w;
    if (reportTools.includes(tool) && typeof handle === 'string' && handle.length <= 64)
      body.reporting = {work_handle: handle};
    void fetch(options.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000),
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${options.token}`},
      body: JSON.stringify(body),
    }).then(response => response.body?.cancel()).catch(() => {});
  } catch {}
}

export default {
  id: 'senpai',
  async server(_context, options) {
    return {'tool.execute.before': (input, output) => send(options, input.sessionID, input.callID, input.tool, output?.args)};
  },
  async setup(context) {
    await context.tool.hook('execute.before', event => {
      send(context.options, event.sessionID, event.id, event.tool, event.input);
    });
  },
};
