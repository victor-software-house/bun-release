---
'bun-release': patch
---

Retry an npm trust OTP 401 that omitted challenge URLs without `npm-otp`, instead of sending a web-login token as `npm-otp`.
