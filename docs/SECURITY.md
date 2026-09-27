# Security policy

## Supported code

Flux is in early development and has no released version. Security fixes are made
on the latest `main` branch; historical commits do not have maintenance branches or
promised backports.

The application on `main` has accounts, sessions and server-side authorization, but
it has not had a security review or a release. Use sample data and do not expose it
as a production service. The `flux-ux-v8.html` prototype has no backend; its
accounts, permissions, AI and integrations are demonstrations.

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
