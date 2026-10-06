# Security policy

## Supported versions

Security fixes are made on `master`, the only supported version. This repository publishes no releases.

## Reporting a vulnerability

Report it privately through GitHub: open the [security advisory form](https://github.com/framerslab/agentos-workbench/security/advisories/new), or email team@frame.dev. Do not open a public issue, pull request or chat message about a vulnerability.

## Response

A maintainer acknowledges a report within 5 business days and sends an assessment and a plan within 14 days.

## Disclosure

A fix ships before details are published, and the reporter is credited unless they decline. At 90 days from the report an advisory is published with the fix or, when no fix exists, with mitigations, unless the reporter and a maintainer agree a later date.

## Scope

In scope: defects in this repository's code, the workbench front end and its backend server, including how the backend handles provider keys, uploaded files, model output and tool results. Out of scope: a flaw in the AgentOS runtime, which belongs in the [agentos](https://github.com/framerslab/agentos/security/policy) repository; a flaw that exists only in a third-party provider's service; and a flaw that exists only in a deployment's own configuration. The backend is a development server with no authentication, so run it only on a machine and a network you trust.
