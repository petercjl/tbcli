# tbcli

Local CLI for Taobao/Qianniu seller backend workflows. It shares the same
“ecommerce browser”（电商浏览器）with the other ecommerce CLIs.

## Install

Supports macOS and Windows. Requires Node.js 20 or newer and Google Chrome:

```bash
npm install -g @petercjl/tbcli
tbcli --help
```

## Requirements

- The ecommerce browser is running with remote debugging on port `9223`.
- The ecommerce browser is already logged in to Taobao/Qianniu seller backend.

By default, `tbcli` opens the shared ecommerce browser:

```bash
tbcli browser open
```

Default browser settings:

- CDP URL: `http://127.0.0.1:9223`
- Chrome profile: `~/.dianshang-chrome-profile` on macOS, `%USERPROFILE%\.dianshang-chrome-profile` on Windows
- macOS Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Windows Chrome: automatically detected under `%LOCALAPPDATA%`, `%PROGRAMFILES%`, or `%PROGRAMFILES(X86)%`

These can be overridden with `TBCLI_CDP_URL`, `TBCLI_CHROME_PROFILE`, `TBCLI_REMOTE_DEBUGGING_PORT`, or `TBCLI_CHROME_PATH`.

On first use, run `tbcli browser open`, then sign in to Taobao/Qianniu manually
in the opened ecommerce browser. npm installs the required `playwright-core`
dependency automatically; Chrome and Node.js are system prerequisites and are
not installed by `tbcli`.

The CLI does not read or store cookies directly. It connects to the logged-in
ecommerce browser through CDP and runs Taobao requests inside the browser page
context. Do not create a separate profile for `tbcli`.

## Verification safety rule

If Taobao shows or is suspected to show a login redirect, slider, CAPTCHA,
security verification, access restriction, or MTOP validation signal, `tbcli`
must stop immediately. It must not retry, refresh, or continue requesting more
pages. Complete the verification manually in the ecommerce browser, then run
the command again. This rule applies to every Taobao data command.

## Commands

Query logistics detail by Taobao trade ID:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239
```

JSON output:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239 --json
```

Save normalized JSON:

```bash
tbcli logistics get --trade-id 5120566455115013148 --seller-id 2208971708239 --out outputs/logistics.json
```

If a current Chrome page URL already contains `seller_id`, `--seller-id` may be omitted.

Export a Tmall/Taobao shop product list through the structured MTOP endpoint used
by the logged-in shop page:

```bash
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --out products.json
tbcli shop products --url 'https://kemi.tmall.com/category.htm?visible=true&show=true' --out products.csv
```

Use `--max-pages N` for a small test run. The command exports product IDs,
titles, links, images, 365-day vague sales, benefits, rankings, and SKU data.
Taobao currently returns the list price as an encoded value; JSON preserves it
as `encodedPrice`, while the normalized `price` field stays empty and
`priceStatus` is `encoded`.
