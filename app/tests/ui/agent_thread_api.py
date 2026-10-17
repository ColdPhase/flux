"""Helpers for browser tests of the agents' thread (#400): the task's thread read in the shape of a task discussion."""

from __future__ import annotations


def as_discussion(thread: dict) -> dict:
    """`GET /api/v1/work/:id/agent-thread` as {conversationId, root, messages}; the first message is the thread's root."""
    conversation = thread.get("conversation") or {"id": None, "messages": []}
    messages = conversation["messages"]
    return {"conversationId": conversation["id"], "root": messages[0] if messages else None, "messages": messages}
