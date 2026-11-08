# Sourced by the Docker UI check scripts after `$compose` is set (#979).
# A test deployment's pages send Flux's Content-Security-Policy with a `report-uri` to the API, and every browser in every test reports
# there what it refused. `csp_violations` reads that list when the tests are over: it prints each report and returns 3 when there is
# one nobody meant to cause. Left out: test_csp's own attacks (csp-control-* pages), a frame-ancestors report (test_oauth_consent frames the
# consent page on purpose to show that it is refused), and an eval report with no source file, which is the
# test driver's own (Playwright's waitForFunction evaluates its predicate with eval; a test stack's enforced policy allows that, and only
# the report-only copy, the policy that ships, reports it). An eval from a script of the app has a source file and is a violation.
csp_violations() {
  violations=$($compose exec -T api node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8080/api/v1/test/csp-reports", { headers: { authorization: `Bearer ${process.env.FLUX_FIXTURE_TOKEN}` } });
    const { reports } = await response.json();
    const driver = (r) => r.directive.startsWith("script-src") && r.blocked === "eval" && !r.source;
    const unintended = reports.filter((r) => !r.document.includes("/csp-control-") && r.directive !== "frame-ancestors" && !driver(r));
    for (const r of unintended) console.log(`${r.directive}  blocked ${r.blocked || "(inline)"}  on ${r.document}${r.source ? `  in ${r.source}:${r.line}` : ""}${r.sample ? `  ${JSON.stringify(r.sample)}` : ""}`);
    process.exit(unintended.length ? 3 : 0);
  ' 2>&1) && return 0
  printf 'Content-Security-Policy violations seen by the browsers during this run:\n%s\n' "$violations" >&2
  return 3
}
