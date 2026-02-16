# Focus Redirector (Chrome Extension, Manifest V3)

Focus Redirector redirects top-level navigation for configured hostnames and their subdomains to target URLs.

## Features

- User-configurable redirect rules stored in `chrome.storage.sync` (with `chrome.storage.local` fallback)
- Hostname + subdomain matching: rule `youtube.com` matches `youtube.com`, `www.youtube.com`, `m.youtube.com`, etc.
- Redirect only on top-level page loads (`main_frame`), so links/embeds on other pages do not trigger redirects
- Immediate rule updates on add/edit/toggle/delete (no browser restart)
- Validation for hostname format, target URL format, and direct self-loop prevention
- Redirect metrics in Options:
  - Total redirect count
  - Per-rule redirect count

## Rule Model

Each rule has:

- `id`: string
- `enabled`: boolean
- `source_hostname`: string (for example `youtube.com`)
- `target_url`: absolute `http://` or `https://` URL

## How It Works

Enabled rules are compiled into dynamic Declarative Net Request rules:

- `action.type = "redirect"`
- `condition.regexFilter = ^https?://([a-z0-9-]+\.)*<escaped_hostname>(?::\d+)?(?:/|$).*`
- `condition.resourceTypes = ["main_frame"]`

This ensures redirects only happen when the browser is actually navigating to that hostname as the main page.

## Install (Unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/spencer/Documents/New project`.
5. Click the extension toolbar icon to open **Focus Redirector Options** directly.

## Usage

1. In options, add a rule:
   - Source hostname: `youtube.com`
   - Target URL: `https://calendar.google.com/calendar/u/0/r`
2. Keep rule enabled.
3. Visit `https://youtube.com`, `https://www.youtube.com`, or another subdomain and it redirects.

## Validation Rules

- `source_hostname`
  - Trimmed and lowercased
  - Must be hostname only (no scheme/path/query)
  - Allows letters, numbers, dots, hyphens
- `target_url`
  - Must parse as absolute URL
  - Must use `http://` or `https://`
- Self-loop prevention
  - Reject if target hostname equals source hostname in the same rule

## Troubleshooting

- Domain not redirecting:
  - Verify the rule is enabled.
  - Verify the source hostname is correct (for example `youtube.com` will match `www.youtube.com` and other subdomains).
  - Verify URL starts with `http://` or `https://`.
- Rules changed but behavior not updated:
  - Reopen options page and confirm no validation errors in the row.
  - Check `chrome://extensions` -> extension service worker logs for runtime errors.
