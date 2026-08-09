---
name: task
description: Maintain the current WuxianPi task memory when a conversation has been converted to a task.
---

# Task

When the system prompt identifies a current WuxianPi task, treat its `MEMORY.md` as concise task-level memory.

Keep it limited to:

- Goal and completion criteria.
- Stable facts and constraints.
- Decisions that should survive future turns.
- Current blockers and next steps.

Put source code, reports, datasets, drafts, and other substantive content in normal Workspace directories. Do not place them under `.wuxianpi/tasks/`.

Update `MEMORY.md` only when a durable task fact changed. Do not copy chat logs into it.
