# Browser roles and account separation

## Contract

The CLI selects a browser role from the operation. A role binds its own CDP endpoint and persistent Chrome Profile; authentication, tabs and themes stay in that Profile. The role describes the intended account, not proof of seller/buyer privileges. Login status checks session-cookie presence; service permission checks still apply.

| Role | Operations | Default CDP | Default Profile | Theme |
| --- | --- | --- | --- | --- |
| `buyer` | `item media`, `item detail` (including reviews/questions), `search products`, `shop products` | `http://127.0.0.1:9224` | `~/.taobao-user-chrome-profile` | Orange |
| `merchant` | DMP (including competitor metadata), SYCM, AI点睛/advertising, seller orders/logistics, finance and other existing browser consumers | `http://127.0.0.1:9223` | `~/.dianshang-chrome-profile` | Blue |

Database, local-file and delegated provider commands keep their existing independent contracts. Public product data may require buyer login. DMP product metadata remains a merchant operation even when the target is a competitor.

## Execution

1. Classify the requested operation using the table; the four buyer commands select `buyer` automatically. Every other business browser operation defaults to `merchant`.
2. For authentication/diagnostics/development helpers specify `--browser-role buyer` or `--browser-role merchant`. For example, `tbcli auth status --browser-role buyer --json`, followed by `tbcli auth login --browser-role buyer` only when needed. The user completes login in the selected window. Never switch the merchant browser to a buyer account to unblock a front-page query.
3. Run the stable data command normally. Buyer auto mode reuses or opens the dedicated CDP browser; explicit managed mode retains its own Profile and sandbox. Merchant auto mode preserves compatibility with the existing CDP/managed behavior. Explicit CDP/profile arguments must match the intended role; role conflicts stop before connection. Local CDP connections verify the Chrome process port/Profile pair.
4. Verify the output and return to the calling Skill's main flow. If login, CAPTCHA or access checks stop execution, preserve completed data and ask the user to handle the selected browser. Never copy cookies, profiles or credentials between roles, and never fall back to the other endpoint.

`tbcli browser open --browser-role buyer --json` is the explicit compatibility launcher. Browser-only requests use the independent host browser launcher when configured, with its explicit buyer role; they do not require this business Skill. The existing default ecommerce browser stays merchant.

`tbcli browser theme --browser-role merchant` applies blue; `--browser-role buyer` applies orange through Chrome's visible profile settings. Settings are persisted by Chrome. A changed Chrome settings UI or unsupported language returns an error; account data remains untouched. Opening an existing Profile retains its current theme.

## Configuration and recovery

Merchant settings retain `TBCLI_CDP_URL`, `TBCLI_CHROME_PROFILE`, `TBCLI_REMOTE_DEBUGGING_PORT`. Buyer settings use separate `TBCLI_BUYER_CDP_URL`, `TBCLI_BUYER_CHROME_PROFILE`, `TBCLI_BUYER_REMOTE_DEBUGGING_PORT`; legacy merchant variables never supply buyer defaults. `TBCLI_CHROME_PATH` and the supported session-mode option remain shared technical settings. Custom endpoints and Profiles must remain distinct across roles.

`BROWSER_ROLE_CONFLICT` means the operation and explicit role disagree. `BROWSER_TARGET_CONFLICT` means an endpoint/Profile overlaps the other role. `BROWSER_PROFILE_CONFLICT` means the local Chrome process does not attest the selected port/Profile pair or the Profile is busy. Inspect the selected endpoint and running Chrome flags; keep both Profiles intact. `BROWSER_THEME_NOT_APPLIED` or a settings timeout requires checking the selected Chrome's profile appearance. Retry only after correcting the stated problem, then return to the operation's normal preflight.

## Verification scope

The default mapping and conflicts have deterministic tests. Live simultaneous Chrome instances and profile themes have been verified on macOS. Windows paths/process lookup are implemented; native Windows runtime verification is separate and remains required before claiming a live pass there.
