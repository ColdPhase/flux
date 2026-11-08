"""The dynamic security test (#838): the OpenAPI document made from the route listing, the triage of ZAP's reports, and the shape of
scripts/check_dast.sh. ZAP itself runs only in Docker (scripts/check_dast.sh); this checks what can be checked without it."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


prepare = load("dast_prepare", "scripts/dast/prepare.py")
SUMMARIZE = ROOT / "scripts/dast/summarize.py"
RULES = ROOT / "scripts/dast/zap-rules.conf"
UUID = "11111111-2222-4333-8444-555555555555"


class OpenApi(unittest.TestCase):
    ROUTES = [
        {"method": "GET", "url": "/api/v1/projects/:projectId/work", "body": None, "query": {"type": "object", "required": ["limit"], "properties": {"limit": {"type": "integer", "minimum": 1}, "q": {"type": ["string", "null"]}}}},
        {"method": "POST", "url": "/api/v1/projects/:projectId/docs", "body": {"type": "object", "required": ["title"], "additionalProperties": False,
            "properties": {"title": {"type": "string", "maxLength": 200}, "parent": {"anyOf": [{"type": "null"}, {"type": "string", "format": "uuid"}]}, "tags": {"type": "array", "items": {"type": "string"}}}}, "query": None},
        {"method": "DELETE", "url": "/api/v1/workspaces/:workspaceId/members/:userId", "body": None, "query": None},
        {"method": "GET", "url": "/api/v1/test/routes", "body": None, "query": None},
        {"method": "GET", "url": "/api/v1/stream", "body": None, "query": None},
        {"method": "GET", "url": "/api/v1/editing", "body": None, "query": None},
        {"method": "DELETE", "url": "/api/v1/sessions/:id", "body": None, "query": None},
        {"method": "HEAD", "url": "/api/v1/me", "body": None, "query": None},
        {"method": "GET", "url": "/api/v1/health", "body": None, "query": None},
    ]

    def document(self, ids=None):
        return prepare.openapi(self.ROUTES, "http://127.0.0.1:8080", ids or {"projectId": UUID})

    def test_paths_use_braces_and_path_parameters_carry_the_real_ids(self):
        paths = self.document({"projectId": UUID, "workspaceId": "w1"})["paths"]
        work = paths["/api/v1/projects/{projectId}/work"]["get"]
        self.assertEqual([(p["name"], p["in"], p["example"]) for p in work["parameters"] if p["in"] == "path"], [("projectId", "path", UUID)])
        member = paths["/api/v1/workspaces/{workspaceId}/members/{userId}"]["delete"]
        examples = {p["name"]: p["example"] for p in member["parameters"]}
        self.assertEqual(examples["workspaceId"], "w1")
        self.assertEqual(examples["userId"], prepare.UUID, "an id nobody found stays a well-formed id that exists nowhere")

    def test_query_and_body_schemas_become_openapi_3_0(self):
        paths = self.document()["paths"]
        query = {p["name"]: p for p in paths["/api/v1/projects/{projectId}/work"]["get"]["parameters"] if p["in"] == "query"}
        self.assertTrue(query["limit"]["required"])
        self.assertEqual(query["limit"]["schema"], {"type": "integer", "minimum": 1})
        self.assertEqual(query["q"]["schema"], {"type": "string", "nullable": True}, "a type list with null is nullable")
        body = paths["/api/v1/projects/{projectId}/docs"]["post"]["requestBody"]
        self.assertTrue(body["required"])
        schema = body["content"]["application/json"]["schema"]
        self.assertEqual(schema["required"], ["title"])
        self.assertEqual(schema["properties"]["title"], {"type": "string", "maxLength": 200})
        self.assertEqual(schema["properties"]["parent"], {"type": "string", "format": "uuid", "nullable": True}, "anyOf with null is nullable")
        self.assertEqual(schema["properties"]["tags"], {"type": "array", "items": {"type": "string"}})
        self.assertIs(schema["additionalProperties"], False)

    def test_what_a_scan_must_not_touch_or_cannot_speak_is_left_out(self):
        paths = self.document()["paths"]
        for left_out in ("/api/v1/test/routes", "/api/v1/stream", "/api/v1/editing", "/api/v1/sessions/{id}"):
            self.assertNotIn(left_out, paths)
        self.assertNotIn("head", paths.get("/api/v1/me", {}))
        self.assertIn("/api/v1/health", paths)

    def test_the_auth_routes_the_listing_does_not_have_are_added_by_hand(self):
        paths = self.document()["paths"]
        self.assertIn("post", paths["/api/auth/sign-in/email"])
        self.assertEqual(paths["/api/auth/sign-in/email"]["post"]["requestBody"]["content"]["application/json"]["schema"]["required"], ["email", "password"])
        self.assertIn("get", paths["/api/auth/get-session"])

    def test_the_document_is_valid_json_with_one_server(self):
        document = json.loads(json.dumps(self.document()))
        self.assertEqual((document["openapi"], document["servers"]), ("3.0.3", [{"url": "http://127.0.0.1:8080"}]))
        for item in document["paths"].values():
            for operation in item.values():
                self.assertTrue(operation["operationId"])
                self.assertIn("default", operation["responses"])


def report(*alerts, site="http://127.0.0.1:8080"):
    return {"site": [{"@name": site, "alerts": [{"pluginid": rule, "name": name, "riskcode": risk, "instances": [{"method": "GET", "uri": uri}]}
                                                 for rule, name, risk, uri in alerts]}]}


def summarize(*documents, rules=None):
    """Runs summarize.py over the documents; returns (exit code, stdout, stderr, summary.md)."""
    with tempfile.TemporaryDirectory() as directory:
        paths = []
        for number, document in enumerate(documents):
            path = Path(directory, f"report-{number}.json")
            path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
            paths.append(str(path))
        rules_path = Path(directory, "rules.conf")
        rules_path.write_text(rules if rules is not None else RULES.read_text(encoding="utf-8"), encoding="utf-8")
        done = subprocess.run([sys.executable, str(SUMMARIZE), "--rules", str(rules_path), "--out", directory, *paths], capture_output=True, text=True)
        summary = Path(directory, "summary.md")
        return done.returncode, done.stdout, done.stderr, summary.read_text(encoding="utf-8") if summary.exists() else ""


class Triage(unittest.TestCase):
    def test_a_medium_alert_nobody_triaged_fails_the_run_and_is_listed(self):
        code, _, _, summary = summarize(report(("40012", "Cross Site Scripting (Reflected)", "3", "http://x/api/v1/q"), ("10021", "Header missing", "1", "http://x/a.js")))
        self.assertEqual(code, 10)
        self.assertIn("## To triage: Medium or higher, not recorded (1)", summary)
        self.assertIn("Cross Site Scripting (Reflected)", summary)
        self.assertIn("Low and informational (1)", summary)

    def test_the_recorded_rules_pass_and_the_summary_gives_each_its_reason(self):
        code, _, _, summary = summarize(report(("10062", "PII Disclosure", "3", "http://x/api/v1/sketches/1"), ("2", "Private IP Disclosure", "2", "http://x/api/auth/get-session"),
                                               ("10055", "CSP: style-src unsafe-inline", "2", "http://x/")))
        self.assertEqual(code, 0)
        self.assertIn("## Recorded false positives (1)", summary)
        self.assertIn("last group of a UUID", summary)
        self.assertIn("## Accepted risks, kept on purpose (1)", summary)
        self.assertIn("Accepted risk: style-src keeps 'unsafe-inline'", summary)

    def test_only_the_style_alert_of_the_csp_rule_is_accepted_the_others_of_that_rule_fail_the_run(self):
        # ZAP's one rule id (10055) has an alert per directive: the policy of #979 is strict for scripts, so each of these is a regression.
        for name in ("CSP: script-src unsafe-inline", "CSP: script-src unsafe-eval", "CSP: Wildcard Directive", "CSP: Failure to Define Directive with No Fallback",
                     "CSP: Header & Meta"):
            code, _, _, summary = summarize(report(("10055", name, "2", "http://x/"), ("10055", "CSP: style-src unsafe-inline", "2", "http://x/")))
            self.assertEqual(code, 10, name)
            self.assertIn(f"| {name} |", summary.split("## Accepted risks")[0], name)
        code, *_ = summarize(report(("10055", "CSP: style-src unsafe-inline", "2", "http://x/")))
        self.assertEqual(code, 0)

    def test_a_rule_scoped_by_alert_name_leaves_other_rules_of_the_same_id_alone(self):
        rules = "10055\tIGNORE\t~^CSP: style-src unsafe-inline$\tAccepted risk: kept on purpose, for the test.\n10055\tIGNORE\t~Notices\tA false positive, for the test.\n"
        code, _, _, summary = summarize(report(("10055", "CSP: style-src unsafe-inline", "2", "http://x/"), ("10055", "CSP: Notices", "2", "http://x/")), rules=rules)
        self.assertEqual(code, 0)
        self.assertIn("Accepted risks, kept on purpose (1)", summary)
        self.assertIn("Recorded false positives (1)", summary)
        code, *_ = summarize(report(("10055", "CSP: Wildcard Directive", "2", "http://x/")), rules=rules)
        self.assertEqual(code, 10)

    def test_a_private_address_is_excused_on_get_session_only(self):
        code, _, _, summary = summarize(report(("2", "Private IP Disclosure", "2", "http://x/api/auth/get-session")))
        self.assertEqual(code, 0)
        self.assertIn("None.", summary)
        code, _, _, summary = summarize(report(("2", "Private IP Disclosure", "2", "http://x/api/v1/projects/1/settings")))
        self.assertEqual(code, 10, "the same alert anywhere else is a finding to triage")
        self.assertIn("Private IP Disclosure", summary)

    def test_the_rules_file_as_shipped_is_valid_and_every_ignore_has_a_reason(self):
        for number, line in enumerate(RULES.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip() or line.startswith("#"):
                continue
            parts = line.split("\t")
            self.assertGreaterEqual(len(parts), 4, f"zap-rules.conf:{number}")
            self.assertIn(parts[1], ("IGNORE", "OUTOFSCOPE", "INFO", "WARN", "FAIL"))
            if parts[1] == "IGNORE":
                self.assertGreater(len(parts[3].strip()), 40, f"zap-rules.conf:{number}: a reason, not a word")

    def test_an_ignore_without_a_reason_is_refused(self):
        code, _, error, _ = summarize(report(("10062", "PII", "3", "http://x/")), rules="10062\tIGNORE\tPII Disclosure\n10063\tIGNORE\tPermissions\t\n")
        self.assertEqual(code, 1)
        self.assertIn("dast:", error)
        code, _, error, _ = summarize(report(("10062", "PII", "3", "http://x/")), rules="10063\tIGNORE\tPermissions\t\n")
        self.assertNotEqual(code, 0)
        self.assertIn("needs its reason", error)

    def test_a_scan_that_did_not_run_is_never_clean(self):
        for bad in ("", "not json", "{}", json.dumps({"site": []}), json.dumps([1])):
            code, _, error, summary = summarize(bad)
            self.assertEqual(code, 1, repr(bad))
            self.assertEqual(summary, "")
            self.assertIn("dast:", error)
        code, _, error, _ = summarize(report(("10062", "PII", "3", "http://x/")), "missing")
        self.assertNotEqual(code, 0)

    def test_out_of_scope_drops_one_rules_alerts_on_matching_urls_only(self):
        rules = "40012\tOUTOFSCOPE\t^http://x/api/v1/legacy/.*$\tThe route returns the text it was given on purpose.\n"
        code, *_ = summarize(report(("40012", "XSS", "3", "http://x/api/v1/legacy/echo")), rules=rules)
        self.assertEqual(code, 0)
        code, *_ = summarize(report(("40012", "XSS", "3", "http://x/api/v1/other")), rules=rules)
        self.assertEqual(code, 10)


class Script(unittest.TestCase):
    SCRIPT = (ROOT / "scripts/check_dast.sh").read_text(encoding="utf-8")

    def test_zap_is_pinned_by_digest_and_runs_in_the_api_containers_network(self):
        self.assertRegex(self.SCRIPT, r'zap_image="ghcr\.io/zaproxy/zaproxy@sha256:[0-9a-f]{64}"')
        self.assertIn('--network "container:$api_container"', self.SCRIPT)
        self.assertIn("-P 8090", self.SCRIPT, "ZAP's own port must not be the API's 8080")

    def test_both_people_are_scanned_actively_and_signed_in_and_the_cookie_is_removed(self):
        self.assertIn("zap-api-scan.py", self.SCRIPT)
        self.assertIn("zap-baseline.py", self.SCRIPT)
        self.assertIn("ada jonas", self.SCRIPT)
        self.assertIn("Cookie=$cookie", self.SCRIPT)
        self.assertIn('rm -f "$out"/cookie-*', self.SCRIPT)
        self.assertIn("summarize.py --rules scripts/dast/zap-rules.conf", self.SCRIPT)

    def test_it_is_a_manual_step_no_workflow_runs(self):
        for workflow in (ROOT / ".github/workflows").glob("*.yml"):
            self.assertNotIn("check_dast", workflow.read_text(encoding="utf-8"), workflow.name)


if __name__ == "__main__":
    unittest.main()
