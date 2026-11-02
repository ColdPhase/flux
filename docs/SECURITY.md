# Security policy

## Supported code

Flux [v0.1.0](https://github.com/ColdPhase/flux/releases/tag/v0.1.0) is the first release, an early version. Security fixes are made
on the latest `main` branch; historical commits and earlier releases do not have
maintenance branches or promised backports.

The application has accounts, sessions and server-side authorization, but it has not
had an independent security review. Read the [hardening guide](operations/hardening.md)
before you expose an instance to the internet.

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
