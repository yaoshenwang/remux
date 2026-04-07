import type { Metadata } from "next";
import { CodeBlock } from "../../components/code-block";
import { Callout } from "../../components/callout";

export const metadata: Metadata = {
  title: "Browser Automation",
  description:
    "remux browser command reference for navigation, DOM interaction, waiting, inspection, JavaScript evaluation, tabs, dialogs, frames, downloads, and browser state.",
};

export default function BrowserAutomationPage() {
  return (
    <>
      <h1>Browser Automation</h1>
      <p>
        The <code>remux browser</code> command group provides browser automation
        against remux browser surfaces. Use it to navigate, interact with DOM
        elements, inspect page state, evaluate JavaScript, and manage browser
        session data.
      </p>

      <h2>Command Index</h2>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Subcommands</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Navigation and targeting</td>
            <td>
              <code>identify</code>, <code>open</code>, <code>open-split</code>,{" "}
              <code>navigate</code>, <code>back</code>, <code>forward</code>,{" "}
              <code>reload</code>, <code>url</code>, <code>focus-webview</code>,{" "}
              <code>is-webview-focused</code>
            </td>
          </tr>
          <tr>
            <td>Waiting</td>
            <td>
              <code>wait</code>
            </td>
          </tr>
          <tr>
            <td>DOM interaction</td>
            <td>
              <code>click</code>, <code>dblclick</code>, <code>hover</code>,{" "}
              <code>focus</code>, <code>check</code>, <code>uncheck</code>,{" "}
              <code>scroll-into-view</code>, <code>type</code>, <code>fill</code>,{" "}
              <code>press</code>, <code>keydown</code>, <code>keyup</code>,{" "}
              <code>select</code>, <code>scroll</code>
            </td>
          </tr>
          <tr>
            <td>Inspection</td>
            <td>
              <code>snapshot</code>, <code>screenshot</code>, <code>get</code>,{" "}
              <code>is</code>, <code>find</code>, <code>highlight</code>
            </td>
          </tr>
          <tr>
            <td>JavaScript and injection</td>
            <td>
              <code>eval</code>, <code>addinitscript</code>, <code>addscript</code>,{" "}
              <code>addstyle</code>
            </td>
          </tr>
          <tr>
            <td>Frames, dialogs, downloads</td>
            <td>
              <code>frame</code>, <code>dialog</code>, <code>download</code>
            </td>
          </tr>
          <tr>
            <td>State and session data</td>
            <td>
              <code>cookies</code>, <code>storage</code>, <code>state</code>
            </td>
          </tr>
          <tr>
            <td>Tabs and logs</td>
            <td>
              <code>tab</code>, <code>console</code>, <code>errors</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Targeting a browser surface</h2>
      <p>
        Most subcommands require a target surface. You can pass it positionally
        or with <code>--surface</code>.
      </p>
      <CodeBlock lang="bash">{`# Open a new browser split
remux browser open https://example.com

# Discover focused IDs and browser metadata
remux browser identify
remux browser identify --surface surface:2

# Positional vs flag targeting are equivalent
remux browser surface:2 url
remux browser --surface surface:2 url`}</CodeBlock>

      <h2>Navigation</h2>
      <CodeBlock lang="bash">{`remux browser open https://example.com
remux browser open-split https://news.ycombinator.com

remux browser surface:2 navigate https://example.org/docs --snapshot-after
remux browser surface:2 back
remux browser surface:2 forward
remux browser surface:2 reload --snapshot-after
remux browser surface:2 url

remux browser surface:2 focus-webview
remux browser surface:2 is-webview-focused`}</CodeBlock>

      <h2>Waiting</h2>
      <p>
        Use <code>wait</code> to block until selectors, text, URL fragments,
        load state, or a JavaScript condition is satisfied.
      </p>
      <CodeBlock lang="bash">{`remux browser surface:2 wait --load-state complete --timeout-ms 15000
remux browser surface:2 wait --selector "#checkout" --timeout-ms 10000
remux browser surface:2 wait --text "Order confirmed"
remux browser surface:2 wait --url-contains "/dashboard"
remux browser surface:2 wait --function "window.__appReady === true"`}</CodeBlock>

      <h2>DOM Interaction</h2>
      <p>
        Mutating actions support <code>--snapshot-after</code> for fast
        verification in scripts.
      </p>
      <CodeBlock lang="bash">{`remux browser surface:2 click "button[type='submit']" --snapshot-after
remux browser surface:2 dblclick ".item-row"
remux browser surface:2 hover "#menu"
remux browser surface:2 focus "#email"
remux browser surface:2 check "#terms"
remux browser surface:2 uncheck "#newsletter"
remux browser surface:2 scroll-into-view "#pricing"

remux browser surface:2 type "#search" "remux"
remux browser surface:2 fill "#email" --text "ops@example.com"
remux browser surface:2 fill "#email" --text ""
remux browser surface:2 press Enter
remux browser surface:2 keydown Shift
remux browser surface:2 keyup Shift
remux browser surface:2 select "#region" "us-east"
remux browser surface:2 scroll --dy 800 --snapshot-after
remux browser surface:2 scroll --selector "#log-view" --dx 0 --dy 400`}</CodeBlock>

      <h2>Inspection</h2>
      <p>
        Use structured getters for scripts and snapshots/screenshots for human
        review.
      </p>
      <CodeBlock lang="bash">{`remux browser surface:2 snapshot --interactive --compact
remux browser surface:2 snapshot --selector "main" --max-depth 5
remux browser surface:2 screenshot --out /tmp/remux-page.png

remux browser surface:2 get title
remux browser surface:2 get url
remux browser surface:2 get text "h1"
remux browser surface:2 get html "main"
remux browser surface:2 get value "#email"
remux browser surface:2 get attr "a.primary" --attr href
remux browser surface:2 get count ".row"
remux browser surface:2 get box "#checkout"
remux browser surface:2 get styles "#total" --property color

remux browser surface:2 is visible "#checkout"
remux browser surface:2 is enabled "button[type='submit']"
remux browser surface:2 is checked "#terms"

remux browser surface:2 find role button --name "Continue"
remux browser surface:2 find text "Order confirmed"
remux browser surface:2 find label "Email"
remux browser surface:2 find placeholder "Search"
remux browser surface:2 find alt "Product image"
remux browser surface:2 find title "Open settings"
remux browser surface:2 find testid "save-btn"
remux browser surface:2 find first ".row"
remux browser surface:2 find last ".row"
remux browser surface:2 find nth 2 ".row"

remux browser surface:2 highlight "#checkout"`}</CodeBlock>

      <h2>JavaScript Eval and Injection</h2>
      <CodeBlock lang="bash">{`remux browser surface:2 eval "document.title"
remux browser surface:2 eval --script "window.location.href"

remux browser surface:2 addinitscript "window.__remuxReady = true;"
remux browser surface:2 addscript "document.querySelector('#name')?.focus()"
remux browser surface:2 addstyle "#debug-banner { display: none !important; }"`}</CodeBlock>

      <h2>State</h2>
      <p>
        Session data commands cover cookies, local/session storage, and full
        browser state snapshots.
      </p>
      <CodeBlock lang="bash">{`remux browser surface:2 cookies get
remux browser surface:2 cookies get --name session_id
remux browser surface:2 cookies set session_id abc123 --domain example.com --path /
remux browser surface:2 cookies clear --name session_id
remux browser surface:2 cookies clear --all

remux browser surface:2 storage local set theme dark
remux browser surface:2 storage local get theme
remux browser surface:2 storage local clear
remux browser surface:2 storage session set flow onboarding
remux browser surface:2 storage session get flow

remux browser surface:2 state save /tmp/remux-browser-state.json
remux browser surface:2 state load /tmp/remux-browser-state.json`}</CodeBlock>

      <h2>Tabs</h2>
      <p>
        Browser tab operations map to browser surfaces in the active browser tab
        group.
      </p>
      <CodeBlock lang="bash">{`remux browser surface:2 tab list
remux browser surface:2 tab new https://example.com/pricing

# Switch by index or by target surface
remux browser surface:2 tab switch 1
remux browser surface:2 tab switch surface:7

# Close current tab or a specific target
remux browser surface:2 tab close
remux browser surface:2 tab close surface:7`}</CodeBlock>

      <h2>Console and Errors</h2>
      <CodeBlock lang="bash">{`remux browser surface:2 console list
remux browser surface:2 console clear

remux browser surface:2 errors list
remux browser surface:2 errors clear`}</CodeBlock>

      <h2>Dialogs</h2>
      <CodeBlock lang="bash">{`remux browser surface:2 dialog accept
remux browser surface:2 dialog accept "Confirmed by automation"
remux browser surface:2 dialog dismiss`}</CodeBlock>

      <h2>Frames</h2>
      <CodeBlock lang="bash">{`# Enter an iframe context
remux browser surface:2 frame "iframe[name='checkout']"
remux browser surface:2 click "#pay-now"

# Return to the top-level document
remux browser surface:2 frame main`}</CodeBlock>

      <h2>Downloads</h2>
      <CodeBlock lang="bash">{`remux browser surface:2 click "a#download-report"
remux browser surface:2 download --path /tmp/report.csv --timeout-ms 30000`}</CodeBlock>

      <h2>Common Patterns</h2>

      <h3>Navigate, wait, inspect</h3>
      <CodeBlock lang="bash">{`remux browser open https://example.com/login
remux browser surface:2 wait --load-state complete --timeout-ms 15000
remux browser surface:2 snapshot --interactive --compact
remux browser surface:2 get title`}</CodeBlock>

      <h3>Fill a form and verify success text</h3>
      <CodeBlock lang="bash">{`remux browser surface:2 fill "#email" --text "ops@example.com"
remux browser surface:2 fill "#password" --text "$PASSWORD"
remux browser surface:2 click "button[type='submit']" --snapshot-after
remux browser surface:2 wait --text "Welcome"
remux browser surface:2 is visible "#dashboard"`}</CodeBlock>

      <h3>Capture debug artifacts on failure</h3>
      <CodeBlock lang="bash">{`remux browser surface:2 console list
remux browser surface:2 errors list
remux browser surface:2 screenshot --out /tmp/remux-failure.png
remux browser surface:2 snapshot --interactive --compact`}</CodeBlock>

      <h3>Persist and restore browser session</h3>
      <CodeBlock lang="bash">{`remux browser surface:2 state save /tmp/session.json
# ...later...
remux browser surface:2 state load /tmp/session.json
remux browser surface:2 reload`}</CodeBlock>
    </>
  );
}
