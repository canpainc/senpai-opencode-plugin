# SenpAI OpenCode plug-in

This plug-in makes one call before an OpenCode tool step. It sends the session
id (`session_id`), the step id (`tool_call_id`) and the tool name (`tool_name`) to
the one address supplied in its settings. The native user-message id (`turn_id`)
lets the server remind once per turn; synthetic reminders do not start a turn. One source file supports OpenCode 1
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

There is one attempt per step, with a five-second timeout and no redirects or retry.
The hook returns immediately, without waiting for a response.
A successful response can carry the server's reporting reminder or steering
text. The plug-in adds that text to the same OpenCode session without rejecting
the tool or starting another model run. OpenCode keeps it in its normal history.
The server decides whether to send it; the plug-in has no reporting rules.
An error, timeout, invalid JSON or an unrecognized answer does nothing.
A failed call does not stop the tool step. The server can therefore miss a call
when it cannot be reached; this is not a durable delivery queue.

OpenCode checks out the exact Git commit named in the company settings.
Git must be available on the managed computer. On an
empty cache, an unreachable download can delay OpenCode and leave the plug-in
unloaded. That behavior belongs to OpenCode and is separate from the plug-in's
call timeout.

Remove the entry from the company settings and restart OpenCode to stop calls.
OpenCode can leave the downloaded package in its own cache. This plug-in creates
no files to remove.

For OpenCode 1, the settings entry is `[package, {endpoint, token}]` inside
`plugin`. For OpenCode 2 it is `{package, options: {endpoint, token}}` inside
`plugins`. Company settings supply the Git HTTPS address, full commit hash and options.

## How to verify

Read `index.js` at the release tag. There is no build step: the release archive
contains that file byte for byte. Unpack the archive to compare it with the tag.
Compare the SHA-256 of the archive your computers download with the checksum
published beside the release. A SenpAI-served copy must have the same checksum.

Set `opencode_plugin_package` on the server to
`senpai-opencode-plugin@git+https://github.com/canpainc/senpai-opencode-plugin.git#<full-40-character-commit>`
for the reviewed release, or use the same form for a company Git mirror.
Both copied settings carry that exact revision. Tags and release-archive addresses
are rejected: a publisher can replace an archive while keeping its address.
OpenCode has no settings field that enforces an archive checksum. The commit pin
selects the reviewed source; it does not detect edits to a developer-owned cache.

The server step-route/settings changes need a server release. This package is
released separately as v0.2.0 after review; publishing a package does not update
company settings. IT pushes the new settings and restarts OpenCode.
