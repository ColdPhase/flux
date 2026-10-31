"""A decision proposed or accepted in a thread leaves a trace (#694): the contract that holds without a browser.

The behaviour is proven in Docker (app/tests/app/object-notices.test.ts and app/tests/ui/test_decision_trace.py). This
reads the sources and records so the parts cannot drift apart unnoticed: one path for the lines in contracts, server and
web; live events that carry identifiers only; the audience of the lines being the project's; the design rule that
allows the lines; and a browser journey that covers computer and phone. Standard library only.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"


def source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class DecisionTrace(unittest.TestCase):
    def test_one_path_for_the_lines_in_contracts_server_and_web(self) -> None:
        self.assertIn("/api/v1/projects/${projectId}/object-notices", source("app/packages/contracts/src/work.ts"))
        self.assertIn("projectObjectNoticesPath(':projectId')", source("app/apps/server/src/work/routes.ts"))
        self.assertIn("projectObjectNoticesPath(projectId)", source("app/apps/web/src/conversations/api.ts"))

    def test_the_lines_are_read_by_the_audience_of_the_project_and_no_one_else(self) -> None:
        service = source("app/packages/core/src/work/service.ts")
        # The same reader path as the task announcements: the project must be readable by the caller.
        self.assertRegex(service, r"listObjectNotices: \(principal: Principal, projectId: string, query\?: PageQuery\): Promise<Page<ObjectNotice>> =>\s+list\(principal, projectId, query")
        self.assertIn("await ports.access.requireProject(principal, 'read', project);", service, "the shared list helper checks read access first")
        # The query is bound to one project and never reads another project's rows.
        repo = source("app/packages/db/src/repositories/work.ts")
        body = repo[repo.index("async listObjectNotices"):repo.index("async updateWork")]
        self.assertEqual(body.count("project_id = ${projectId}"), 3, "every branch of the union is bound to the project")
        self.assertNotIn("workspace_id =", body)

    def test_live_events_carry_identifiers_only(self) -> None:
        service = source("app/packages/core/src/work/service.ts")
        for kind, key in (("project.decision_proposed.v1", "decisionId"), ("project.decision_accepted.v1", "decisionId"), ("project.result_recorded.v1", "resultId")):
            calls = re.findall(rf"events\.record\([^;]*?'{re.escape(kind)}'[^;]*?\{{([^}}]*)\}}\)", service)
            self.assertTrue(calls, f"{kind} is recorded")
            for payload in calls:
                self.assertEqual(re.findall(r"(\w+):", payload), [key], f"{kind} carries only {key}")
        # What the open conversation does with an event: read again. It never reads text from the event.
        one = source("app/apps/web/src/app/OneConversation.tsx")
        handler = one[one.index("useStreamEvents(me.user.id"):]
        handler = handler[:handler.index("});")]
        for kind in ("decision_(proposed|accepted)", "result_recorded", "work_created"):
            self.assertIn(kind, handler)
        self.assertIn("revalidator.revalidate()", handler)
        self.assertNotRegex(handler, r"event\.(title|body|data|text)")

    def test_the_design_allows_the_lines_and_the_thread_commands_carry_their_source(self) -> None:
        design = source("docs/design/final/README.md")
        rule = next(line for line in design.splitlines() if line.startswith("| P5 |"))
        for words in ("#694", "decision", "result", "card", "thread"):
            self.assertIn(words, rule)
        conversation = source("app/apps/web/src/conversations/useComposerSend.ts")
        self.assertRegex(conversation, r"fromThread = conversation && rootMessageId \?")
        self.assertIn("kind: 'propose-decision', projectId: project.id, title: text, ...(fromThread", conversation)
        self.assertIn("sources: [{ ref: { type: 'message' as const, id: fromThread.messageId }", conversation)

    def test_a_card_never_decides_or_changes_anything(self) -> None:
        component = source("app/apps/web/src/app/ObjectNotices.tsx")
        # One button, and it only opens the object in Details; the line has no reply, accept or other action of its own.
        self.assertEqual(len(re.findall(r"<button", component)), 3, "the source link, the thread link and the card")
        code = re.sub(r"/\*.*?\*/", "", component, flags=re.S)
        self.assertNotRegex(code, r"accept|propose|fetch\(|request\(")
        self.assertIn("onOpen(target)", component)

    def test_the_browser_journey_covers_computer_phone_and_both_engines(self) -> None:
        journey = source("app/tests/ui/test_decision_trace.py")
        for phone in ("phone=False", "phone=True"):
            self.assertIn(phone, journey)
        self.assertIn('os.environ.get("FLUX_UI_BROWSER", "chromium")', journey, "chromium by default, webkit through FLUX_UI_BROWSER")
        for step in ("/decide", "name=\"Accept\", exact=True", "to_have_count(2)", "object-notices"):
            self.assertIn(step, journey)
        # Two people: the one who proposes and the one who has the thread open and is not touched.
        self.assertIn('self.page("ada", phone=phone), self.page("jonas", phone=phone)', journey)

    def test_the_change_is_in_the_changelog(self) -> None:
        fragment = source("changes/694-decision-trace.added.md")
        self.assertTrue(fragment.startswith("- "))
        self.assertIn("issues/694", fragment)


if __name__ == "__main__":
    unittest.main()
