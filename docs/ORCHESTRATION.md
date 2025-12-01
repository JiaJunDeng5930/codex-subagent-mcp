# Orchestration

The built-in `orchestrator` agent is just another sub-agent you can call with `delegate` or `delegate_batch`. There is no request/step persistence, token gating, or envelope rewriting.

- `delegate` runs the named agent directly. If you pass `agent="orchestrator"`, it uses the orchestrator persona to plan and delegate follow-up work as text.
- `delegate_batch` runs multiple items in parallel; the input is `{ items: [{ agent, task, ... }] }`.
- No `request_id` or `ORCHESTRATOR_TOKEN` is required or produced, and the server no longer creates `orchestration/<request>/` folders or `todo.json`.

Use the orchestrator when you want a planning agent to break down the task; otherwise call your target agent directly.
