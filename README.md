# SenpAI OpenCode plug-in

This plug-in makes one call before an OpenCode tool step. It sends the session
id (`session_id`), the step id (`tool_call_id`) and the tool name (`tool_name`) to
the one address supplied in its settings. The native user-message id (`turn_id`)
lets the server remind once per turn; synthetic reminders do not start a turn. One source file supports OpenCode 1
and 2. A before-step call proves neither completion nor success.

For computers enrolled with LiteLLM, Setup also sets `modelAttempts`. On a model request the plug-in sends OpenCode’s session ID and a new request key to the same address. When it sees the provider’s ID in the reply, it sends that ID with the same request key. Failed calls keep their original key. The gateway supplies the price. The plug-in forwards the response to OpenCode as it arrives and inspects at most the first 32 KiB for the ID. Native trace and log export stay off.

For SenpAI's own report step only, it also copies `c.w` to
`reporting.work_handle` for a UUIDv7 in canonical unpadded base64url.
The server validates that handle and finds the report's action; the plug-in
never derives an action or assigns a ticket. Invalid references stay local.
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

The plug-in checks the entire command or batch against the reporting fields before delivery. It refuses unknown fields and wrong types on the computer. OpenCode 2 can convert a text command to an object first. If the plug-in receives text, it stops the call and asks for an object. The client drops an invalid operation name before sending a compact report and uses the unnamed task for a legacy event. The computer checks names and other report fields for the reporting, native client and LiteLLM keys issued by Setup. It also checks names against the local conversation. It checks report explanations against the local conversation. A match of 32 UTF-16 units, a complete shorter text (including one copied without surrounding whitespace), incomplete history or a comparison beyond the local limit triggers fixed wording for the main explanation. The same check stops a report containing an unverifiable category, written defect ID or label, bug-origin reason or evidence locator. A UUID defect ID stays usable. Only fingerprints and a substitution count stay in memory. The local error names the field. The count is available on `senpai.opencode.report_substitutions`.

## Windows rollout

In Setup, connect the company’s LiteLLM gateway. Copy the same settings for OpenCode 1 and 2. Merge these entries into `C:\ProgramData\opencode\opencode.json` on every computer. Before restarting OpenCode, clear `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` from its launch settings. Older Setup pages provide a separate `opencode-managed.json` for each version. With those files, apply the matching `config` and `environment` sections. Keep a copy of the original machine policy and permissions. Give standard users read access and administrators or SYSTEM write access. Restart OpenCode, including the OpenCode 2 background service.

Set the model provider to the company gateway and distribute a separate gateway key per developer with the company’s credential system. Keep that key out of the shared file. Install the company CA in the Windows trust store if needed and apply the usual proxy and no-proxy settings for the gateway.

The managed gateway and default model take precedence over conflicting user, project and environment settings. Extra providers can still merge in. Limit selectable providers with `enabled_providers` on OpenCode 1 or `provider.use` policies on OpenCode 2. A developer can choose an allowed model on the command line. OpenCode 1 can skip external plug-ins in pure mode. Use company network and gateway controls when all requests must use that gateway. Administrators can change the machine policy.

Start a session and check the issued key’s last use in Setup. After the cost round, compare the session’s charge with the developer’s gateway receipt. To remove the integration, restore the previous machine file, launch environment and access rules, revoke the retired SenpAI key in Setup, and restart OpenCode. Remove only the plug-in’s package from OpenCode’s own cache if IT requires a clean disk. The plug-in installs no service.

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
