# tbcli development rules

This repository is developed through Codex. Treat the following rules as release-blocking requirements.

## Business capability registry

- Every stable, user-facing ecommerce command must be registered in `src/tbcli/command-registry.mjs` with `audience: 'business'`.
- Its capability entry must include an ecommerce-facing name, description, natural-language example prompt, required inputs, optional inputs, delivery, and CLI command template.
- Describe what an ecommerce operator can accomplish. Do not use API, CDP, selectors, interception, decoding, or other implementation details in the business-facing wording.
- `tbcli capabilities` and `tbcli capabilities --json` are generated from this registry. Do not maintain a separate handwritten capability list.
- Internal browser, diagnostic, and development commands must be marked `internal` or `development`, not presented as business capabilities.

## Taobao request safety

- Every stable Taobao data command must enter through `withAuthenticatedTaobaoSession`; never send a data request before the login check passes.
- Every API request and every retry must enter through a shared request policy. The default interval is a random 1000-2000ms delay.
- `shop products` is the page-action exception: page 1 must follow the initial shop navigation, and every later page must be reached by a real pagination click. Start observing the page's own `/i/asynSearch.htm` request before the navigation or click, then perform a random 3000-5000ms guarded page-action wait while the page renders that response. Require evidence of the real request and parse every rendered main product row before the pagination boundary; page capacity is dynamic and must not be hard-coded. Do not directly call a substitute product API, directly jump to later page URLs, include recommendation rows, or retry a failed page load.
- `shop products` must atomically update its checkpoint after every successful page. If login, verification, access restriction, or another error stops the command, preserve the last successful page in the checkpoint and print its path.
- Product price restoration must prefer the plaintext list price embedded in the requested shop response, then the pinned official secfont runtime when only encoded display text is available. It may fall back only to already requested shop-list pages. Do not visit individual item detail pages to fill missing prices; return `PARTIAL_DATA` and preserve the checkpoint instead.
- A secfont runtime may execute only when both resource URLs are fixed HTTPS `g.alicdn.com` paths and both decompressed resources match the pinned SHA-256 fingerprints. Stop instead of executing changed or untrusted runtime code.
- Check the active page for login, CAPTCHA, slider, security verification, access restriction, and MTOP validation signals before and after waiting and after receiving a response.
- Any login or verification signal must stop the command immediately. Do not retry, refresh, bypass, or continue to the next page.
- Do not add a direct `fetch`, MTOP request, or equivalent Taobao data call to a stable command without routing it through the shared request policy and verification guards.

## Required tests

- A new business command is incomplete until the capability-registry tests pass.
- Add tests proving its API path uses the shared delay and stop policy. Product pagination tests must also prove that the click occurs before the guarded wait and request.
- Run `npm test` before committing or publishing.
