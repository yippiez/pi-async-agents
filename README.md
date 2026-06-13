# Moved to pchain

This repository has moved into the pchain monorepo:

- https://github.com/yippiez/pchain
- Pi implementation: `pchain/pi/`

This repo is kept only for history and compatibility.

---

# pi-async-agents

Background pure RPC async agents for Pi.

## User API

```text
/fork <task>
```

Bare `/fork` stays Pi's built-in fork picker. `/fork <task>` launches a background pure RPC child agent.

Child agents run with:

```text
--mode rpc --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --tools read,grep,find,ls
```

Finished child output is sent back to the main conversation as a follow-up user message.

## Extension event API

Other extensions can launch a forked async agent by emitting:

```ts
pi.events.emit("pi-async-agents:fork", {
  task: "Investigate image crop code",
  name: "scout",       // optional
  model: "...",        // optional
  tools: "read,grep",  // optional, default read,grep,find,ls
  cwd: "/path",        // optional
});
```

Updates are emitted on:

```ts
pi.events.on("pi-async-agents:update", (job) => { ... });
```

Capability probe:

```ts
pi.events.emit("pi-async-agents:capabilities:request", {
  requestId,
  replyTo: "my-extension:capabilities:response",
});
```

## UI

The extension renders a compact below-editor widget with recent async agent status.

Prompt-chain or another extension can open the internal panel by emitting:

```ts
pi.events.emit("pi-async-agents:panel:open", {});
```
