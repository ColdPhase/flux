# Security policy

## Supported code

Flux v0.2 is the current version, and an early one. Security fixes are made
on the latest `main` branch; historical commits and earlier releases (v0.1.0 included) do not have
maintenance branches or promised backports.

The application has accounts, sessions and server-side authorization. In November 2026 an
agent that did not write the code reviewed v0.2: the [threat model](security/threat-model.md)
and an [OWASP ASVS 4.0.3 Level 2 checklist](security/asvs-l2.md) list what was checked, and
every finding is an issue in the v0.2 milestone (#837). It found no P1, and its P2 and P3 findings (password rules and
sign-in guessing, local clients after a password reset, error messages, response headers, a security log and the first sign-up on a
new server, which since [#1471](https://github.com/ColdPhase/flux/issues/1471) needs the setup link) are fixed, or recorded as an accepted risk in the [hardening guide](operations/hardening.md). A [penetration test](security/pentest-v0.2.md) of authorization and isolation between spaces and people
found no break, and a dynamic scan with OWASP ZAP (`./scripts/check_dast.sh`) and the repository's dependency, image and
CodeQL scanning run alongside. Release images are signed. An agent review is not a human audit. The project plans an external human penetration test
and cryptography review before Flux is offered for production use by companies. The scope is in the threat model's
[external audit section](security/threat-model.md#external-human-audit-decision-for-837). Password accounts have no multi-factor
sign-in: for a server reachable from the internet, single sign-on with your identity provider's MFA is the way to get it. Read the
[hardening guide](operations/hardening.md) before you expose an instance to the internet.

## Report a vulnerability

Use GitHub's [private vulnerability reporting form](https://github.com/ColdPhase/flux/security/advisories/new).
You can also find it under **Security → Advisories → Report a vulnerability**.
Reports are shared privately with repository maintainers.

Please include:

- The affected commit or prototype revision, browser, and operating system.
- Steps to reproduce the problem and a minimal proof of concept, if available.
- The expected impact and any conditions needed to trigger it.
- A suggested mitigation, if you have one.

Remove real credentials and personal information from examples. Do not publish
exploit details in a public issue or PR before coordinating with the maintainers.

Maintainers will use the private report to discuss impact, reproduction, and a
fix or disclosure plan. The project currently has no guaranteed response time.
Ordinary bugs and feature requests belong in
[Issues](https://github.com/ColdPhase/flux/issues/new/choose).
