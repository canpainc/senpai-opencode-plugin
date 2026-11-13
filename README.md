# SenpAI OpenCode plug-in

This plug-in makes one call before an OpenCode tool step. It sends the session
id (`session_id`), the step id (`tool_call_id`) and the tool name (`tool_name`) to
the one address supplied in its settings. One source file supports OpenCode 1
and 2. A before-step call proves neither completion nor success.

For SenpAI's own report step only, it also copies `c.w` to
`reporting.work_handle` when it is a string of at most 64 characters.
The server validates that handle and finds the report's action; the plug-in
never derives an action or assigns a ticket. Missing, non-string or longer
values are omitted. Legacy event IDs are never sent.
Only `senpai_report_events`, `senpai-report_events` and
`mcp__senpai__report_events` carry references. Use the `senpai` reporting name
in company settings. Other tools send only the three native fields.

Apart from that compact handle, it never sends tool arguments. It never sends
prompts, answers, file contents, command output,
repository names, branches or commits. It never reads or writes files, reads
environment variables, starts a process, adds a data label or installs a service.
It has no dependencies. OpenCode supplies its options: `endpoint` (the complete
hook URL, `/v1/hooks/step/{source_id}`) and `token` (the native client credential
issued for these company settings). It identifies the company source, not a
person, and goes in the Authorization header, never the body or a log.
Never put the company source/registration credential, gateway signing key,
reporting-tool key or model-provider key in the plug-in options.

There is one attempt per step, with a one-second timeout and no redirects or retry.
The hook returns immediately, without waiting for a response.
A failed call does not stop the tool step. The server can therefore miss a call
when it cannot be reached; this is not a durable delivery queue.

OpenCode downloads the pinned package named in the company settings. On an
empty cache, an unreachable download can delay OpenCode and leave the plug-in
unloaded. That behavior belongs to OpenCode and is separate from the plug-in's
call timeout.

Remove the entry from the company settings and restart OpenCode to stop calls.
OpenCode can leave the downloaded package in its own cache. This plug-in creates
no files to remove.

For OpenCode 1, the settings entry is `[package, {endpoint, token}]` inside
`plugin`. For OpenCode 2 it is `{package, options: {endpoint, token}}` inside
`plugins`. Company settings supply the pinned download address and options.

## How to verify

Read `index.js` at the release tag. There is no build step: the release archive
contains that file byte for byte. Unpack the archive to compare it with the tag.
Compare the SHA-256 of the archive your computers download with the checksum
published beside the release. A SenpAI-served copy must have the same checksum.

Your company may host the reviewed archive at its own internal address and use
that address in the settings. Pin the version in the download address; OpenCode
does not select a newer version by itself. Keep the file at that address unchanged.
