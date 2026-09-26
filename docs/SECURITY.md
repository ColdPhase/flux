# Security policy

## Supported code

Flux is currently an unreleased, local UX prototype. Security fixes are made on
the latest `main` branch. Historical commits and prototype revisions do not have
separate maintenance branches or promised backports.

The prototype has no production authentication, server-side authorization, or
shared backend. Its accounts, permissions, AI, and integrations are demonstrations.
Use sample data while evaluating it and do not expose it as a production service.

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
