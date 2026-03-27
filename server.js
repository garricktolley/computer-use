import 'dotenv/config';
import { WebSocketServer } from 'ws';
import express from 'express';
import { createServer } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, 'generated-apis');

const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic();

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeKey(key) {
  return key
    .split('+')
    .map(part => {
      const lower = part.toLowerCase().trim();
      const map = {
        ctrl: 'Control', control: 'Control',
        alt: 'Alt', shift: 'Shift',
        meta: 'Meta', super: 'Meta', cmd: 'Meta', command: 'Meta',
        return: 'Enter', enter: 'Enter',
        esc: 'Escape', escape: 'Escape',
        backspace: 'Backspace', del: 'Delete', delete: 'Delete',
        tab: 'Tab', space: ' ',
        up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
        pageup: 'PageUp', page_up: 'PageUp',
        pagedown: 'PageDown', page_down: 'PageDown',
        home: 'Home', end: 'End',
      };
      return map[lower] || part;
    })
    .join('+');
}

function formatAction(action) {
  switch (action.action) {
    case 'screenshot': return 'Taking screenshot';
    case 'left_click': return `Click at (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'right_click': return `Right-click at (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'double_click': return `Double-click at (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'triple_click': return `Triple-click at (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'middle_click': return `Middle-click at (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'type': return `Type: "${action.text.length > 60 ? action.text.slice(0, 60) + '...' : action.text}"`;
    case 'key': return `Key: ${action.key}`;
    case 'mouse_move': return `Move mouse to (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'scroll': return `Scroll ${action.scroll_direction} by ${action.scroll_amount}`;
    case 'left_click_drag': return `Drag to (${action.coordinate[0]}, ${action.coordinate[1]})`;
    case 'wait': return `Waiting...`;
    default: return action.action;
  }
}

function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

async function takeScreenshot(page) {
  const buffer = await page.screenshot({ type: 'jpeg', quality: 75 });
  return buffer.toString('base64');
}

// ── Network Capture ──────────────────────────────────────────────────────────

const SKIP_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'manifest', 'other']);
const SKIP_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|ico|css|woff2?|ttf|eot|mp[34]|webp|avif)(\?|$)/i;

function setupNetworkCapture(page) {
  const captured = [];

  const onResponse = async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    const url = request.url();
    const method = request.method();

    if (SKIP_RESOURCE_TYPES.has(resourceType)) return;
    if (SKIP_EXTENSIONS.test(url)) return;

    const isApiLike = resourceType === 'xhr' || resourceType === 'fetch'
      || ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (!isApiLike) return;

    let responseBody = null;
    try { responseBody = await response.text(); } catch {}

    captured.push({
      url,
      method,
      resourceType,
      requestHeaders: request.headers(),
      requestPostData: request.postData() || null,
      responseStatus: response.status(),
      responseHeaders: response.headers(),
      responseBody,
      timestamp: Date.now(),
    });
  };

  page.on('response', onResponse);

  return {
    getRequests: () => [...captured],
    detach: () => page.removeListener('response', onResponse),
  };
}

// ── Traffic Analysis ─────────────────────────────────────────────────────────

async function analyzeTraffic(requests, originalTask) {
  const trimmed = requests.slice(-30).map(r => ({
    ...r,
    responseBody: r.responseBody && r.responseBody.length > 2000
      ? r.responseBody.slice(0, 2000) + '...[truncated]'
      : r.responseBody,
    requestPostData: r.requestPostData && r.requestPostData.length > 2000
      ? r.requestPostData.slice(0, 2000) + '...[truncated]'
      : r.requestPostData,
  }));

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are analyzing network traffic captured during a browser automation task.

The user's original task was: "${originalTask}"

Here are the captured HTTP requests (XHR/fetch only):

${JSON.stringify(trimmed, null, 2)}

Your job:
1. Identify the key API request(s) that represent the core action (form submission, data fetch, file download, etc.)
2. Generate a standalone Node.js Express route that wraps/proxies this request
3. Extract editable parameters from the URL, request body, query string, and headers

Respond with EXACTLY this JSON structure (no markdown fences, no extra text):
{
  "summary": "One sentence describing what the API does",
  "requestConfig": {
    "url": "the target URL with {{parameter}} placeholders where appropriate",
    "method": "POST",
    "headers": { "Content-Type": "...", "other": "headers..." },
    "body": "the request body template with {{parameter}} placeholders, or null"
  },
  "parameters": [
    { "name": "paramName", "in": "body|url|header|query", "default": "captured value", "description": "what this parameter is" }
  ],
  "code": "full standalone Express server code"
}

The "code" field should be a complete, runnable Node.js file that:
- Uses import syntax (ESM)
- Creates an Express app on port 3001
- Has a single POST /api/run endpoint
- Accepts the parameters as JSON body fields
- Uses native fetch() to make the upstream request
- Returns the upstream response
- Has helpful comments explaining what it does

Skip auth tokens / cookies from parameters unless they are clearly user-provided values.`
    }],
  });

  const text = response.content[0].text;
  const cleaned = text.replace(/^```json?\n?/gm, '').replace(/\n?```$/gm, '').trim();
  return JSON.parse(cleaned);
}

// ── Smart Mode ───────────────────────────────────────────────────────────────

const SMART_TOOL = {
  name: 'browser_action',
  description: 'Perform a browser action. Use this tool to interact with the web page.',
  input_schema: {
    type: 'object',
    required: ['thought', 'action'],
    properties: {
      thought: {
        type: 'string',
        description: 'Your reasoning about what to do next based on the accessibility snapshot and the task.',
      },
      action: {
        type: 'string',
        enum: ['click', 'fill', 'navigate', 'script', 'scroll', 'select', 'press_key', 'wait', 'done'],
        description: 'The action to perform.',
      },
      selector: {
        type: 'string',
        description: 'Playwright selector for the target element. Use role selectors like role=button[name="Submit"], text selectors like text="Click me", or CSS selectors like #id, .class. Required for click, fill, select.',
      },
      value: {
        type: 'string',
        description: 'Text to type (fill), URL (navigate), JS code (script), scroll direction "up"/"down" (scroll), key combo like "Enter" (press_key), or option value (select).',
      },
    },
  },
};

async function getAccessibilitySnapshot(page) {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    if (snapshot.length > 30000) {
      return snapshot.slice(0, 30000) + '\n... [truncated]';
    }
    return snapshot;
  } catch {
    return '[Failed to get accessibility snapshot]';
  }
}

function formatSmartAction(input) {
  switch (input.action) {
    case 'click': return `Click: ${input.selector}`;
    case 'fill': return `Fill "${input.selector}" with "${input.value}"`;
    case 'navigate': return `Navigate to ${input.value}`;
    case 'script': return `Run script: ${input.value?.slice(0, 80)}${(input.value?.length || 0) > 80 ? '...' : ''}`;
    case 'scroll': return `Scroll ${input.value || 'down'}`;
    case 'select': return `Select "${input.value}" in ${input.selector}`;
    case 'press_key': return `Press key: ${input.value}`;
    case 'wait': return 'Waiting...';
    case 'done': return 'Task complete';
    default: return input.action;
  }
}

async function executeSmartAction(page, input) {
  switch (input.action) {
    case 'click':
      await page.locator(input.selector).click({ timeout: 5000 });
      break;
    case 'fill':
      await page.locator(input.selector).fill(input.value, { timeout: 5000 });
      break;
    case 'navigate':
      await page.goto(input.value);
      await page.waitForLoadState('domcontentloaded');
      break;
    case 'script':
      await page.evaluate(input.value);
      break;
    case 'scroll': {
      const delta = (input.value || 'down').toLowerCase() === 'up' ? -500 : 500;
      await page.mouse.wheel(0, delta);
      break;
    }
    case 'select':
      await page.locator(input.selector).selectOption(input.value, { timeout: 5000 });
      break;
    case 'press_key':
      await page.keyboard.press(input.value);
      break;
    case 'wait':
      await new Promise(r => setTimeout(r, 1500));
      break;
    case 'done':
      break;
  }
}

async function runSmartAgent(task, ws, signal, captureNetwork, startUrl) {
  let browser = null;

  try {
    send(ws, { type: 'status', text: 'Launching browser (Smart Mode)...' });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let networkCapture = null;
    if (captureNetwork) {
      networkCapture = setupNetworkCapture(page);
      send(ws, { type: 'status', text: 'Network capture enabled' });
    }

    const navUrl = startUrl || 'https://www.google.com';
    send(ws, { type: 'status', text: `Navigating to ${navUrl}...` });
    await page.goto(navUrl);
    await page.waitForLoadState('domcontentloaded');

    const initialScreenshot = await takeScreenshot(page);
    send(ws, { type: 'screenshot', data: initialScreenshot });

    const initialSnapshot = await getAccessibilitySnapshot(page);
    send(ws, { type: 'status', text: 'Agent is thinking...' });

    const siteContext = startUrl
      ? `The browser is open to ${navUrl}.`
      : 'The browser is open to Google.';

    const systemPrompt = `You are a browser automation agent. You interact with web pages using structured accessibility data — not screenshots. ${siteContext}

You will receive a YAML-like accessibility snapshot of the current page. Use the browser_action tool to interact with the page.

For selectors, use Playwright-compatible selectors derived from the snapshot:
- Role selectors: role=button[name="Submit"], role=link[name="About"], role=textbox[name="Search"]
- Text selectors: text="Some visible text"
- CSS selectors: #id, .class, input[type="email"]
- Combine: role=textbox[name="Search"] >> nth=0

When you see an element like: heading "Example" [level=1], you can target it with role=heading[name="Example"].
When you see: textbox "Search", you can target it with role=textbox[name="Search"].
When you see: link "Click here", you can target it with role=link[name="Click here"].

Call browser_action with action "done" when the task is complete.`;

    const messages = [
      {
        role: 'user',
        content: `Task: ${task}\n\nCurrent page accessibility snapshot:\n\`\`\`\n${initialSnapshot}\n\`\`\``,
      },
    ];

    let step = 0;
    const MAX_STEPS = 50;

    while (step < MAX_STEPS) {
      if (signal.aborted) {
        send(ws, { type: 'done', message: 'Agent stopped by user.' });
        break;
      }

      step++;
      send(ws, { type: 'step', step, maxSteps: MAX_STEPS });

      const response = await client.messages.create(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          tools: [SMART_TOOL],
          messages,
        },
        { signal },
      );

      messages.push({ role: 'assistant', content: response.content });

      let hasToolUse = false;
      let isDone = false;
      const toolResults = [];

      for (const block of response.content) {
        if (signal.aborted) break;

        if (block.type === 'text' && block.text.trim()) {
          send(ws, { type: 'thought', text: block.text });
        } else if (block.type === 'tool_use' && block.name === 'browser_action') {
          hasToolUse = true;
          const input = block.input;

          if (input.thought) {
            send(ws, { type: 'thought', text: input.thought });
          }

          if (input.action === 'done') {
            isDone = true;
            send(ws, { type: 'action', text: 'Task complete' });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Task marked as done.',
            });
            continue;
          }

          send(ws, { type: 'action', text: formatSmartAction(input) });

          let resultText = 'Action executed successfully.';
          try {
            await executeSmartAction(page, input);
            await new Promise(r => setTimeout(r, 500));
            try { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch {}
          } catch (err) {
            resultText = `Action failed: ${err.message}`;
            send(ws, { type: 'action_error', text: resultText });
          }

          const screenshot = await takeScreenshot(page);
          send(ws, { type: 'screenshot', data: screenshot });

          const snapshot = await getAccessibilitySnapshot(page);
          resultText += `\n\nUpdated page accessibility snapshot:\n\`\`\`\n${snapshot}\n\`\`\``;

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultText,
          });
        }
      }

      if (isDone || !hasToolUse || response.stop_reason === 'end_turn') {
        send(ws, { type: 'done', message: 'Task completed.' });
        break;
      }

      if (signal.aborted) {
        send(ws, { type: 'done', message: 'Agent stopped by user.' });
        break;
      }

      messages.push({ role: 'user', content: toolResults });
      send(ws, { type: 'status', text: 'Agent is thinking...' });
    }

    if (step >= MAX_STEPS) {
      send(ws, { type: 'done', message: `Reached maximum steps (${MAX_STEPS}).` });
    }

    // Post-run: analyze captured traffic (reuse existing logic)
    if (networkCapture && !signal.aborted) {
      networkCapture.detach();
      const requests = networkCapture.getRequests();
      send(ws, { type: 'network_summary', count: requests.length });

      if (requests.length > 0) {
        send(ws, { type: 'status', text: 'Analyzing captured network traffic...' });
        try {
          const apiResult = await analyzeTraffic(requests, task);
          await mkdir(GENERATED_DIR, { recursive: true });
          const filename = `api-${Date.now()}.js`;
          const filepath = path.join(GENERATED_DIR, filename);
          await writeFile(filepath, apiResult.code);

          send(ws, {
            type: 'generated_api',
            code: apiResult.code,
            parameters: apiResult.parameters,
            summary: apiResult.summary,
            filename,
            requestConfig: apiResult.requestConfig,
          });
        } catch (err) {
          send(ws, { type: 'error', message: `API analysis failed: ${err.message}` });
        }
      } else {
        send(ws, { type: 'status', text: 'No API requests captured during this run.' });
      }
    }
  } catch (err) {
    if (signal.aborted) {
      send(ws, { type: 'done', message: 'Agent stopped by user.' });
    } else {
      console.error('Smart agent error:', err);
      send(ws, { type: 'error', message: err.message });
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ── Browser Actions (Visual Mode) ───────────────────────────────────────────

async function executeAction(page, action) {
  switch (action.action) {
    case 'screenshot':
      break;
    case 'left_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1]);
      break;
    case 'right_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
      break;
    case 'double_click':
      await page.mouse.dblclick(action.coordinate[0], action.coordinate[1]);
      break;
    case 'triple_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { clickCount: 3 });
      break;
    case 'middle_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'middle' });
      break;
    case 'mouse_move':
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      break;
    case 'left_click_drag':
      if (action.start_coordinate) {
        await page.mouse.move(action.start_coordinate[0], action.start_coordinate[1]);
      }
      await page.mouse.down();
      await page.mouse.move(action.coordinate[0], action.coordinate[1], { steps: 10 });
      await page.mouse.up();
      break;
    case 'left_mouse_down':
      if (action.coordinate) await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      await page.mouse.down();
      break;
    case 'left_mouse_up':
      if (action.coordinate) await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      await page.mouse.up();
      break;
    case 'type':
      await page.keyboard.type(action.text, { delay: 12 });
      break;
    case 'key':
      await page.keyboard.press(normalizeKey(action.key));
      break;
    case 'hold_key':
      await page.keyboard.down(normalizeKey(action.key));
      await new Promise(r => setTimeout(r, action.duration || 500));
      await page.keyboard.up(normalizeKey(action.key));
      break;
    case 'scroll': {
      if (action.coordinate) {
        await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      }
      const dir = action.scroll_direction;
      const amt = (action.scroll_amount || 3) * 120;
      const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
      const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
      await page.mouse.wheel(dx, dy);
      break;
    }
    case 'wait':
      await new Promise(r => setTimeout(r, action.duration || 1000));
      break;
    default:
      console.log('Unhandled action:', action.action);
  }
}

// ── Agent Loop ───────────────────────────────────────────────────────────────

async function runAgent(task, ws, signal, captureNetwork, startUrl) {
  let browser = null;

  try {
    send(ws, { type: 'status', text: 'Launching browser...' });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Set up network capture if enabled
    let networkCapture = null;
    if (captureNetwork) {
      networkCapture = setupNetworkCapture(page);
      send(ws, { type: 'status', text: 'Network capture enabled' });
    }

    const navUrl = startUrl || 'https://www.google.com';
    send(ws, { type: 'status', text: `Navigating to ${navUrl}...` });
    await page.goto(navUrl);
    await page.waitForLoadState('domcontentloaded');

    const initialScreenshot = await takeScreenshot(page);
    send(ws, { type: 'screenshot', data: initialScreenshot });
    send(ws, { type: 'status', text: 'Agent is thinking...' });

    const siteContext = startUrl
      ? `The browser is open to ${navUrl}.`
      : 'The browser is open to Google.';

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: initialScreenshot },
          },
          {
            type: 'text',
            text: `You are controlling a browser via screenshots and mouse/keyboard actions. ${siteContext} Complete this task:\n\n${task}`,
          },
        ],
      },
    ];

    let step = 0;
    const MAX_STEPS = 50;

    while (step < MAX_STEPS) {
      if (signal.aborted) {
        send(ws, { type: 'done', message: 'Agent stopped by user.' });
        break;
      }

      step++;
      send(ws, { type: 'step', step, maxSteps: MAX_STEPS });

      const response = await client.beta.messages.create(
        {
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          tools: [
            {
              type: 'computer_20251124',
              name: 'computer',
              display_width_px: DISPLAY_WIDTH,
              display_height_px: DISPLAY_HEIGHT,
            },
          ],
          messages,
          betas: ['computer-use-2025-11-24'],
        },
        { signal },
      );

      messages.push({ role: 'assistant', content: response.content });

      let hasToolUse = false;
      const toolResults = [];

      for (const block of response.content) {
        if (signal.aborted) break;

        if (block.type === 'thinking') {
          // Skip thinking blocks in the log
        } else if (block.type === 'text' && block.text.trim()) {
          send(ws, { type: 'thought', text: block.text });
        } else if (block.type === 'tool_use' && block.name === 'computer') {
          hasToolUse = true;
          const action = block.input;

          send(ws, { type: 'action', text: formatAction(action) });

          try {
            if (action.action !== 'screenshot') {
              await executeAction(page, action);
              await new Promise(r => setTimeout(r, 400));
              try { await page.waitForLoadState('domcontentloaded', { timeout: 2000 }); } catch {}
            }
          } catch (err) {
            send(ws, { type: 'action_error', text: `Action failed: ${err.message}` });
          }

          const screenshot = await takeScreenshot(page);
          send(ws, { type: 'screenshot', data: screenshot });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: screenshot },
              },
            ],
          });
        }
      }

      if (!hasToolUse || response.stop_reason === 'end_turn') {
        send(ws, { type: 'done', message: 'Task completed.' });
        break;
      }

      if (signal.aborted) {
        send(ws, { type: 'done', message: 'Agent stopped by user.' });
        break;
      }

      messages.push({ role: 'user', content: toolResults });
      send(ws, { type: 'status', text: 'Agent is thinking...' });
    }

    if (step >= MAX_STEPS) {
      send(ws, { type: 'done', message: `Reached maximum steps (${MAX_STEPS}).` });
    }

    // ── Post-run: analyze captured traffic ──
    if (networkCapture && !signal.aborted) {
      networkCapture.detach();
      const requests = networkCapture.getRequests();
      send(ws, { type: 'network_summary', count: requests.length });

      if (requests.length > 0) {
        send(ws, { type: 'status', text: 'Analyzing captured network traffic...' });
        try {
          const apiResult = await analyzeTraffic(requests, task);
          await mkdir(GENERATED_DIR, { recursive: true });
          const filename = `api-${Date.now()}.js`;
          const filepath = path.join(GENERATED_DIR, filename);
          await writeFile(filepath, apiResult.code);

          send(ws, {
            type: 'generated_api',
            code: apiResult.code,
            parameters: apiResult.parameters,
            summary: apiResult.summary,
            filename,
            requestConfig: apiResult.requestConfig,
          });
        } catch (err) {
          send(ws, { type: 'error', message: `API analysis failed: ${err.message}` });
        }
      } else {
        send(ws, { type: 'status', text: 'No API requests captured during this run.' });
      }
    }
  } catch (err) {
    if (signal.aborted) {
      send(ws, { type: 'done', message: 'Agent stopped by user.' });
    } else {
      console.error('Agent error:', err);
      send(ws, { type: 'error', message: err.message });
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ── API Execute Endpoint ─────────────────────────────────────────────────────

app.post('/api/execute', async (req, res) => {
  try {
    const { url, method, headers, body } = req.body;

    if (!url || !method) {
      return res.status(400).json({ error: 'url and method are required' });
    }

    const fetchOptions = { method, headers: headers || {} };
    if (body && method !== 'GET') {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const upstream = await fetch(url, fetchOptions);
    const responseBody = await upstream.text();

    let parsedBody;
    try { parsedBody = JSON.parse(responseBody); } catch { parsedBody = responseBody; }

    res.json({
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: parsedBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('Client connected');
  let abortController = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'start') {
        if (abortController) abortController.abort();
        abortController = new AbortController();
        const sig = abortController.signal;
        const capture = message.captureNetwork || false;
        const url = message.startUrl || null;
        if (message.mode === 'smart') {
          runSmartAgent(message.task, ws, sig, capture, url);
        } else {
          runAgent(message.task, ws, sig, capture, url);
        }
      } else if (message.type === 'stop') {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    if (abortController) abortController.abort();
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nBrowser Agent running at http://localhost:${PORT}\n`);
});
