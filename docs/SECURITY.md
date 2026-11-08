# Security policy

## Supported code

Flux [v0.1.0](https://github.com/ColdPhase/flux/releases/tag/v0.1.0) is the first release, an early version. Security fixes are made
on the latest `main` branch; historical commits and earlier releases do not have
maintenance branches or promised backports.

The application has accounts, sessions and server-side authorization. In November 2026 an
agent that did not write the code reviewed v0.2: the [threat model](security/threat-model.md)
and an [OWASP ASVS 4.0.3 Level 2 checklist](security/asvs-l2.md) list what was checked, and
every finding is an issue in the v0.2 milestone (#837). It found no P1. An agent review is not a
human audit. The project plans an external human penetration test and cryptography review before
Flux is offered for production use by companies. The scope is in the threat model's
[external audit section](security/threat-model.md#external-human-audit-decision-for-837). Until
the password and session findings are fixed, use single sign-on for any server reachable from the
internet. Read the [hardening guide](operations/hardening.md) before you expose an instance to the
internet.

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
