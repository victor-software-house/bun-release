# Changelog

## 0.0.3

### Patch Changes

- Verify annotated release tags against their peeled commit instead of the tag object ([`a932293`](https://github.com/victor-software-house/bun-release/commit/a9322938d4bce125e6922a79b3dda65dbf9a5a69)).

## 0.0.2

### Patch Changes

- Bootstrap packs with bun and PUTs over fetch, completing npm web OTP without bun publish's TTY prompt. Accepted PUTs now continue immediately while public registry visibility is verified concurrently ([`16985fe`](https://github.com/victor-software-house/bun-release/commit/16985fecc8d1c69e6afcac37cd4d225e79bade73)).
- Start npm web login with `{ hostname }` so `POST /-/v1/login` is not treated as a publish ([`16985fe`](https://github.com/victor-software-house/bun-release/commit/16985fecc8d1c69e6afcac37cd4d225e79bade73)).
- Retry an npm trust OTP 401 that omitted challenge URLs without `npm-otp`, instead of sending a web-login token as `npm-otp` ([`16985fe`](https://github.com/victor-software-house/bun-release/commit/16985fecc8d1c69e6afcac37cd4d225e79bade73)).
- Describe the npm registry contract in vendor OpenAPI and generate the Hey API client and Zod schemas from it ([`16985fe`](https://github.com/victor-software-house/bun-release/commit/16985fecc8d1c69e6afcac37cd4d225e79bade73)).
- Smoke a published package with bun. Node cannot resolve `import { $ } from 'bun'` ([`2dbff19`](https://github.com/victor-software-house/bun-release/commit/2dbff19754665e20ce959ac726f0a0558c771c26)).
- Retry GitHub trust list/create with npm-otp after the same web 401 challenge used on publish ([`16985fe`](https://github.com/victor-software-house/bun-release/commit/16985fecc8d1c69e6afcac37cd4d225e79bade73)).

## 0.0.1

### Patch Changes

- Add one-time npm first-publication bootstrap: browser web login, isolated `bun publish`, and GitHub OIDC trust ([`17abb9b`](https://github.com/victor-software-house/bun-release/commit/17abb9bb00351ddda07b4d3a21c6e23647f25498)).

## 0.0.0

Bootstrap: OIDC handshake, packument lookup, changelog slice, and git tag peel for `bun publish` on public npm.
