# Omegent

Configured namespace: `omegent`. Endpoint verified on 2026-10-08:
`https://omega.omegent.com/mcp`, Streamable HTTP with T3 OAuth/PKCE managed by
MCPX. This is Patrick's remote T3 environment, not the local `t3-code` server.
Use gateway-prefixed targets explicitly to avoid operating on the wrong host.

## Login and Cloudflare

Add the remote URL without a fabricated API-key header. Use
`mcpx__management_login_server` to obtain the authorization URL and give it to
the user. In this setup, the callback is `http://localhost:9000/auth/callback`,
so complete the browser flow on the Mac running MCPX. When retrying sign-in,
give the latest returned link; do not open a browser when the user wants to
finish manually.

The setup successfully completed OAuth despite a Cloudflare Access login on
the browser approval page. That page can use interactive browser login;
MCPX does not inherit its cookies. `/mcp`, OAuth discovery, registration, and
the token endpoint must be reachable by the protocol client. A T3 bearer-token
401 at `/mcp` is the expected unauthenticated response; an Access redirect on
a machine endpoint blocks that flow.

A Python probe received Cloudflare error 1010 while MCPX's actual Node client
reached T3 successfully. Diagnose with the actual client's response before
concluding the endpoint is universally blocked. Cloudflare service-token
headers authenticate Access, not T3 OAuth, and are not needed by this verified
connection.

After approval, check `management_list_servers` and make bounded
`t3_environment_read` and `orchestrator_capabilities` calls. The observed
environment label was `t3vm` and the connection reported `full-access`;
re-read identity and permission ceiling rather than treating these as permanent.

## Find, continue, or start remote work

- `t3_thread_search` searches titles/content across projects for an outside
  caller omitting `projectId`. Results are bounded and not exhaustive.
  Read the actual thread with `t3_thread_read` after a match.
- Read incrementally with `afterPosition=nextPosition`. For a truncated item,
  use `itemId` and successive `textOffset=nextTextOffset` values. Paste the
  returned thread link when referring to the conversation.
- `t3_thread_send` with `mode: auto` starts an idle conversation, steers an
  active turn, or queues behind one. Use a stable `clientRequestId` for retries
  of the same message and retain the returned `threadId` and `runId`.
- `t3_thread_wait` reports durable completion; timeout does not cancel work.
  Read the reply afterward. A coordinator's completed turn can still have
  delegated children working and wake later; follow the requested outcome,
  not just that first turn's status.
- For an explicitly requested new top-level conversation, use
  `t3_thread_launch`. It has no retry key; after a lost response, inspect the
  thread list before launching again. Provide `projectId` or `scratch: true`
  as required by the live schema.

## Delegation and publishing

An outside OAuth caller lacks a remote parent-thread binding. Tools such as
`delegate_task`, `task_status`, `create_threads`, and worktree handoff require
an agent running inside a remote T3 thread; their catalog presence does not
prove they work directly from MCPX. Send the task to the appropriate remote
coordinator when the user requests delegated work.

Choose provider/model IDs from live `orchestrator_capabilities`, including
reasoning options. For each delegated review round, the remote coordinator
must call `delegate_task` again with the brief, previous findings/responses,
and unresolved objections; it tracks each `taskId`. Do not start another review
by sending to the delegated child's backing `childThreadId`.

Keep prompts concise and specify the intended terminal state. For a requested
PR, verify its real URL, head, and `isDraft` state before reporting it ready.
Register the PR in the local thread through its `link_pull_request` tool as well
as any remote linkage. Local tests, CI, merge, and deployment are separate facts.

The remote Discord bridge can mirror replies automatically. A request to return
an answer in T3 does not disable that bridge; distinguish automatic mirroring
from asking an agent to send an additional Discord message.
