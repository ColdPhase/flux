"""A decision proposed in a thread leaves a trace, one card that accepting changes in place (#694, #1424 D): the contract that holds without a browser.

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
        self.assertRegex(service, r"listObjectNotices: \(principal: Principal, projectId: string, query\?: PageQuery, reach\?: NoticeReach\): Promise<Page<ObjectNotice>> =>\s+list\(principal, projectId, query")
        self.assertIn("await ports.access.requireProject(principal, 'read', project);", service, "the shared list helper checks read access first")
        # The query is bound to one project and never reads another project's rows.
        repo = source("app/packages/db/src/repositories/work.ts")
        body = repo[repo.index("async listObjectNotices"):repo.index("async updateWork")]
        # One card per decision (#1424 D): one read of the project's decisions, bound to the project.
        self.assertEqual(body.count("project_id = ${projectId}"), 1, "the query is bound to the project")
        self.assertNotIn("workspace_id =", body)

    def test_live_events_carry_identifiers_only(self) -> None:
        service = source("app/packages/core/src/work/service.ts")
        for kind, key in (("project.decision_proposed.v1", "decisionId"), ("project.decision_accepted.v1", "decisionId")):
            calls = re.findall(rf"events\.record\([^;]*?'{re.escape(kind)}'[^;]*?\{{([^}}]*)\}}\)", service)
            self.assertTrue(calls, f"{kind} is recorded")
            for payload in calls:
                self.assertEqual(re.findall(r"(\w+):", payload), [key], f"{kind} carries only {key}")
        # What the open conversation does with an event: read again. It never reads text from the event.
        one = source("app/apps/web/src/app/OneConversation.tsx")
        handler = one[one.index("useStreamEvents(me.user.id"):]
        handler = handler[:handler.index("});")]
        # Every change to the space's work, decisions or results (#862: `WORK_EVENT`), not only a new one.
        self.assertIn("WORK_EVENT.test(event.kind)", handler)
        stream = source("app/apps/web/src/api/stream.ts")
        pattern = stream[stream.index("export const WORK_EVENT"):].split("\n", 1)[0]
        for kind in ("work_", "decision_", "result_"):
            self.assertIn(kind, pattern)
        self.assertIn("revalidator.revalidate()", handler)
        self.assertNotRegex(handler, r"event\.(title|body|data|text)")

    def test_the_design_allows_the_lines_and_the_thread_commands_carry_their_source(self) -> None:
        design = source("docs/design/final/README.md")
        rule = next(line for line in design.splitlines() if line.startswith("| P5 |"))
        for words in ("#694", "decision", "card", "thread"):
            self.assertIn(words, rule)
        conversation = source("app/apps/web/src/conversations/useComposerSend.ts")
        self.assertRegex(conversation, r"fromThread = conversation && rootMessageId \?")
        # `/decide` opens the one Create window on Decision, as `/task` opens it on Task (#1419), with the same source.
        self.assertIn("kind: name === 'decide' ? 'decision' : 'task', projectId: project.id, title: firstLine(text), onCreated: consume,", conversation)
        self.assertIn("sources: [{ ref: { type: 'message' as const, id: fromThread.messageId }", conversation)

    def test_a_card_never_decides_or_changes_anything(self) -> None:
        component = source("app/apps/web/src/app/ObjectNotices.tsx")
        # Every button only opens or links; the line has no reply, accept or other action of its own (#1424: an acceptance
        # line names the decision, its title opening it, beside the card's source and thread links and the card itself).
        handlers = re.findall(r"<button\b[^>]*?onClick=\{([^}]*)\}", component)
        self.assertEqual(handlers, [
            "toMessage",  # the source link: brings the message it came from into view
            "() => onOpenThread(notice.conversationId!)",  # the thread link: opens that thread
            "() => open(target)",  # the card: opens the decision
        ], "three buttons, each opening or linking (an acceptance changes the card in place and adds no line, #1424 D)")
        self.assertEqual(len(re.findall(r"<button", component)), len(handlers), "no button without a known handler")
        # Opening never decides: it opens the decision, and a proposal of the reader's own whose request is still on its way
        # (it is sent at once, #1424 L) opens once it exists.
        opening = component[component.index("const open = "):component.index("const message = ")]
        self.assertEqual(re.findall(r"\b(onOpen|decisionOnceMade|isPendingDecision)\(", opening), ["isPendingDecision", "onOpen", "decisionOnceMade", "onOpen"])
        to_message = component[component.index("const toMessage = "):component.index("const link = ")]
        self.assertEqual(re.findall(r"\.(\w+)\(", to_message), ["getElementById", "scrollIntoView", "focus"])
        code = re.sub(r"/\*.*?\*/", "", component, flags=re.S)
        # It calls no accept or propose and reads or writes nothing itself ('decision.proposed' only names the card's kind).
        self.assertNotRegex(code, r"(?i)\w*(accept|propose)\w*\(|fetch\(|request\(|from '[^']*/api'")
        self.assertIn("if (!isPendingDecision(to.id)) { onOpen(to); return; }", opening, "a decision that exists only opens")

    def test_the_browser_journey_covers_computer_phone_and_both_engines(self) -> None:
        journey = source("app/tests/ui/test_decision_trace.py")
        for phone in ("phone=False", "phone=True"):
            self.assertIn(phone, journey)
        self.assertIn('os.environ.get("FLUX_UI_BROWSER", "chromium")', journey, "chromium by default, webkit through FLUX_UI_BROWSER")
        for step in ("/decide", "name=\"Accept\", exact=True", "convo-object__decided", "object-notices"):
            self.assertIn(step, journey)
        # Two people: the one who proposes and the one who has the thread open and is not touched.
        self.assertIn('self.page("ada", phone=phone), self.page("jonas", phone=phone)', journey)

    def test_the_change_is_in_the_changelog(self) -> None:
        # The entry was a changes/ fragment until release 0.1.0 moved it into the changelog.
        changelog = source("CHANGELOG.md")
        self.assertIn("[#694](https://github.com/ColdPhase/flux/issues/694)", changelog)


if __name__ == "__main__":
    unittest.main()
