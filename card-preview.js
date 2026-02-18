#!/usr/bin/env node

/**
 * adaptive-card-preview — Playwright automation tool
 *
 * Captures rendered card snapshots from the official Microsoft
 * Adaptive Cards Designer (https://adaptivecards.microsoft.com/designer).
 *
 * Usage:
 *   node card-preview.js --card <path.json> [options]
 *   node card-preview.js --batch <dir> [options]
 *   node card-preview.js --discover --headed   # inspect Designer DOM
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    card: null,
    batch: null,
    width: null,
    theme: null,
    output: path.join(process.cwd(), "snapshots"),
    headed: false,
    discover: false,
    timeout: 30000,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--card":
        opts.card = args[++i];
        break;
      case "--batch":
        opts.batch = args[++i];
        break;
      case "--width":
        opts.width = args[++i];
        break;
      case "--theme":
        opts.theme = args[++i];
        break;
      case "--output":
        opts.output = args[++i];
        break;
      case "--headed":
        opts.headed = true;
        break;
      case "--discover":
        opts.discover = true;
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
adaptive-card-preview — capture rendered snapshots from the official Designer

Usage:
  node card-preview.js --card <path.json> [options]
  node card-preview.js --batch <dir>      [options]
  node card-preview.js --discover --headed

Options:
  --card <path>       Path to a single card JSON file
  --batch <dir>       Directory of card JSON files to process
  --width <preset>    Width: verynarrow | narrow | standard | wide (default: all)
  --theme <mode>      Theme: light | dark (default: both)
  --output <dir>      Output directory for screenshots (default: ./snapshots)
  --headed            Show the browser window (useful for debugging)
  --discover          Inspect the Designer DOM and log element info
  --timeout <ms>      Page load timeout in ms (default: 30000)
  --help              Show this help message

Examples:
  # Single card, all combos (8 screenshots: 4 widths x 2 themes)
  node card-preview.js --card ./test-cards/simple-text.json

  # Specific width + theme
  node card-preview.js --card ./card.json --width narrow --theme dark

  # Batch directory
  node card-preview.js --batch ./test-cards/

  # Interactive debugging
  node card-preview.js --card ./card.json --headed
`);
}

// ---------------------------------------------------------------------------
// Constants — discovered from the live Designer DOM
// ---------------------------------------------------------------------------

const DESIGNER_URL = "https://adaptivecards.microsoft.com/designer";

// Menu item labels (exact text from the Designer's Fluent UI dropdown)
const WIDTH_MENU_ITEMS = {
  verynarrow: "Very narrow",
  narrow: "Narrow",
  standard: "Standard width",
  wide: "Wide",
};
const THEME_MENU_ITEMS = {
  light: "Light theme",
  dark: "Dark theme",
};

const ALL_WIDTHS = Object.keys(WIDTH_MENU_ITEMS);
const ALL_THEMES = Object.keys(THEME_MENU_ITEMS);

// ---------------------------------------------------------------------------
// Monaco injection script — runs BEFORE the page loads
// ---------------------------------------------------------------------------

/**
 * This init script intercepts the webpack chunk push to extract
 * __webpack_require__, then finds the Monaco editor module and
 * exposes it as window.__monacoEditor for later use.
 *
 * Approach: webpack 5 stores module factories in the chunk array.
 * By pushing a fake chunk, we receive the require function. We then
 * iterate all module IDs, call require(id) to get exports, and look
 * for one that has editor.getModels().
 */
const MONACO_INIT_SCRIPT = `
(function() {
  // Poll until the webpack chunk and Monaco are ready
  const MAX_ATTEMPTS = 50;
  let attempts = 0;

  function tryExtract() {
    attempts++;
    const chunk = window.webpackChunkac_react_tool_app;
    if (!chunk) {
      if (attempts < MAX_ATTEMPTS) setTimeout(tryExtract, 200);
      return;
    }

    let webpackRequire = null;
    try {
      chunk.push([[Math.random()], {}, (req) => { webpackRequire = req; }]);
    } catch (e) {}

    if (!webpackRequire || !webpackRequire.m) {
      if (attempts < MAX_ATTEMPTS) setTimeout(tryExtract, 200);
      return;
    }

    // Iterate all modules to find Monaco editor API
    const moduleIds = Object.keys(webpackRequire.m);
    for (const id of moduleIds) {
      try {
        const exp = webpackRequire(id);
        if (!exp) continue;
        // Direct: { editor: { getModels: fn } }
        if (exp.editor && typeof exp.editor.getModels === "function") {
          window.__monacoEditor = exp.editor;
          return;
        }
        // Default export
        if (exp.default && exp.default.editor && typeof exp.default.editor.getModels === "function") {
          window.__monacoEditor = exp.default.editor;
          return;
        }
        // Top-level getModels
        if (typeof exp.getModels === "function") {
          window.__monacoEditor = exp;
          return;
        }
      } catch (e) {
        // Module may throw — skip
      }
    }

    // Retry if not found yet (Monaco may not be loaded yet)
    if (!window.__monacoEditor && attempts < MAX_ATTEMPTS) {
      setTimeout(tryExtract, 200);
    }
  }

  // Start polling after a short delay to let the page begin loading
  setTimeout(tryExtract, 500);
})();
`;

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function waitForDesignerReady(page, timeout) {
  console.log("  Waiting for Designer to load...");
  await page.waitForLoadState("networkidle", { timeout });
  await page.waitForSelector(".acd-code-editor .monaco-editor", { timeout });
  await page.waitForSelector(".acd-toolbar", { timeout });
  await page.waitForSelector(".ac-adaptiveCard", { timeout });
  await page.waitForTimeout(1500);

  // Dismiss any modal dialogs (welcome, cookie, etc.)
  await dismissDialogs(page);

  // Wait for our init script to find Monaco
  await page.waitForFunction(() => !!window.__monacoEditor, { timeout }).catch(() => {
    console.log("  Warning: Monaco editor API not found via init script");
  });

  console.log("  Designer loaded.");
}

async function dismissDialogs(page) {
  const selectors = [
    'div[role="dialog"] button:has-text("Close")',
    'div[role="dialog"] button:has-text("Got it")',
    'div[role="dialog"] button:has-text("OK")',
    'div[role="dialog"] button:has-text("Dismiss")',
    'div[role="dialog"] button[aria-label="Close"]',
    '.fui-DialogSurface button:has-text("Close")',
    '.fui-DialogSurface button:has-text("Got it")',
  ];
  for (const selector of selectors) {
    const btn = page.locator(selector);
    if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
      console.log("  Dismissing dialog...");
      await btn.first().click();
      await page.waitForTimeout(500);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Monaco injection — uses the global reference set by init script
// ---------------------------------------------------------------------------

async function injectCardJSON(page, cardJson) {
  console.log("  Injecting card JSON...");

  const result = await page.evaluate((json) => {
    const editor = window.__monacoEditor;
    if (!editor || typeof editor.getModels !== "function") {
      return { success: false, error: "Monaco editor API not available" };
    }
    const models = editor.getModels();
    if (models.length === 0) {
      return { success: false, error: "no Monaco models" };
    }
    // Find the model with the card payload
    for (const model of models) {
      const value = model.getValue();
      if (value.includes("AdaptiveCard") || value.includes("$schema")) {
        model.setValue(json);
        return { success: true, method: "model-match", models: models.length };
      }
    }
    // Fallback: first model
    models[0].setValue(json);
    return { success: true, method: "first-model", models: models.length };
  }, cardJson);

  if (result.success) {
    console.log(`  Injected via ${result.method} (${result.models} models)`);
    return true;
  }

  console.log(`  ${result.error}`);
  return false;
}

// ---------------------------------------------------------------------------
// Toolbar interactions — Fluent UI MenuButton dropdowns
// ---------------------------------------------------------------------------

async function selectFromMenuButton(page, buttonPartialText, menuItemText) {
  const menuButton = page.locator(
    `.acd-toolbar button:has-text("${buttonPartialText}")`
  );
  if ((await menuButton.count()) === 0) return false;

  await menuButton.first().click();
  await page.waitForTimeout(300);

  // Fluent UI renders menu items in a portal with role="menuitem"
  let menuItem = page.getByRole("menuitem", { name: menuItemText });
  if ((await menuItem.count()) === 0) {
    menuItem = page.getByRole("menuitemradio", { name: menuItemText });
  }
  if ((await menuItem.count()) === 0) {
    menuItem = page.getByRole("option", { name: menuItemText });
  }

  if ((await menuItem.count()) > 0) {
    await menuItem.first().click();
    await page.waitForTimeout(500);
    return true;
  }

  await page.keyboard.press("Escape");
  return false;
}

async function setWidthPreset(page, width) {
  const targetLabel = WIDTH_MENU_ITEMS[width];
  if (!targetLabel) {
    console.log(`  Unknown width preset: ${width}`);
    return false;
  }
  console.log(`  Setting width: ${targetLabel}...`);

  // Check if already set
  const btn = page.locator('.acd-toolbar button:has-text("width"), .acd-toolbar button:has-text("Narrow"), .acd-toolbar button:has-text("Wide"), .acd-toolbar button:has-text("Very")');
  if ((await btn.count()) > 0) {
    const currentText = await btn.first().textContent();
    if (currentText && currentText.trim() === targetLabel) {
      console.log(`  Width already set`);
      return true;
    }
    // Click the current width button to open the dropdown
    await btn.first().click();
    await page.waitForTimeout(300);

    let menuItem = page.getByRole("menuitem", { name: targetLabel });
    if ((await menuItem.count()) === 0) {
      menuItem = page.getByRole("menuitemradio", { name: targetLabel });
    }
    if ((await menuItem.count()) > 0) {
      await menuItem.first().click();
      await page.waitForTimeout(500);
      console.log(`  Width set to "${targetLabel}"`);
      return true;
    }
    await page.keyboard.press("Escape");
  }

  console.log(`  Warning: Could not set width to "${targetLabel}"`);
  return false;
}

async function setTheme(page, theme) {
  const targetLabel = THEME_MENU_ITEMS[theme];
  if (!targetLabel) {
    console.log(`  Unknown theme: ${theme}`);
    return false;
  }
  console.log(`  Setting theme: ${targetLabel}...`);

  const btn = page.locator('.acd-toolbar button:has-text("theme")');
  if ((await btn.count()) > 0) {
    const currentText = await btn.first().textContent();
    if (currentText && currentText.trim() === targetLabel) {
      console.log(`  Theme already set`);
      return true;
    }
  }

  const success = await selectFromMenuButton(page, "theme", targetLabel);
  if (success) {
    console.log(`  Theme set to "${targetLabel}"`);
    return true;
  }
  console.log(`  Warning: Could not set theme to "${targetLabel}"`);
  return false;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function screenshotCardPreview(page, outputPath) {
  const selectors = [
    ".acd-designer-cardArea",
    ".acd-designer-host",
    ".ac-adaptiveCard",
    ".acd-previewAndBottomDocks",
  ];
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if ((await el.count()) > 0 && (await el.isVisible())) {
      const box = await el.boundingBox();
      if (box && box.width > 10 && box.height > 10) {
        await el.screenshot({ path: outputPath });
        console.log(
          `  Saved: ${path.basename(outputPath)} (${Math.round(box.width)}x${Math.round(box.height)})`
        );
        return true;
      }
    }
  }
  // Fallback: full page
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`  Saved (full page): ${path.basename(outputPath)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Discovery mode
// ---------------------------------------------------------------------------

async function discoverDOM(page) {
  console.log("\n=== DOM Discovery ===\n");

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map((b) => ({
      text: b.textContent?.trim().substring(0, 80),
      id: b.id,
      class: b.className?.substring(0, 80),
    }))
  );
  console.log("BUTTONS:", buttons.length);
  buttons.forEach((b, i) => console.log(`  [${i}] "${b.text}" id=${b.id}`));

  const editors = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".monaco-editor")).map((e) => ({
      uri: e.getAttribute("data-uri"),
      parent: e.parentElement?.className?.substring(0, 80),
      rect: e.getBoundingClientRect(),
    }))
  );
  console.log("\nMONACO EDITORS:", editors.length);
  editors.forEach((e, i) =>
    console.log(`  [${i}] uri=${e.uri} parent="${e.parent}" ${Math.round(e.rect.width)}x${Math.round(e.rect.height)}`)
  );

  const hasMonaco = await page.evaluate(() => !!window.__monacoEditor);
  console.log(`\nMonaco API available: ${hasMonaco}`);

  if (hasMonaco) {
    const models = await page.evaluate(() => {
      const m = window.__monacoEditor.getModels();
      return m.map((model) => ({
        uri: model.uri?.toString(),
        lang: model.getLanguageId?.() || "unknown",
        length: model.getValue().length,
        preview: model.getValue().substring(0, 100),
      }));
    });
    console.log("MODELS:", models.length);
    models.forEach((m, i) =>
      console.log(`  [${i}] uri=${m.uri} lang=${m.lang} len=${m.length}\n      "${m.preview}..."`)
    );
  }

  // Click the width button to see menu items
  const widthBtn = page.locator('.acd-toolbar button:has-text("width"), .acd-toolbar button:has-text("Narrow"), .acd-toolbar button:has-text("Wide"), .acd-toolbar button:has-text("Very")');
  if ((await widthBtn.count()) > 0) {
    await widthBtn.first().click();
    await page.waitForTimeout(300);
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())
    );
    console.log("\nWIDTH MENU ITEMS:", items);
    await page.keyboard.press("Escape");
  }

  // Click the theme button to see menu items
  const themeBtn = page.locator('.acd-toolbar button:has-text("theme")');
  if ((await themeBtn.count()) > 0) {
    await themeBtn.first().click();
    await page.waitForTimeout(300);
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())
    );
    console.log("THEME MENU ITEMS:", items);
    await page.keyboard.press("Escape");
  }

  console.log("\n=== End Discovery ===\n");
}

// ---------------------------------------------------------------------------
// Card processing
// ---------------------------------------------------------------------------

async function processCard(page, cardPath, opts) {
  const cardName = path.basename(cardPath, ".json");
  const cardJson = fs.readFileSync(cardPath, "utf-8");

  try {
    JSON.parse(cardJson);
  } catch (e) {
    console.error(`  Invalid JSON in ${cardPath}: ${e.message}`);
    return [];
  }

  console.log(`\nProcessing: ${cardName}`);

  const injected = await injectCardJSON(page, cardJson);
  if (!injected) {
    console.error(`  Failed to inject card JSON — skipping`);
    return [];
  }
  await page.waitForTimeout(1500);

  const widths = opts.width ? [opts.width] : ALL_WIDTHS;
  const themes = opts.theme ? [opts.theme] : ALL_THEMES;
  const screenshots = [];

  for (const theme of themes) {
    await setTheme(page, theme);
    for (const width of widths) {
      await setWidthPreset(page, width);
      await page.waitForTimeout(800);

      const filename = `${cardName}-${width}-${theme}.png`;
      const outputPath = path.join(opts.output, filename);
      await screenshotCardPreview(page, outputPath);
      screenshots.push(outputPath);
    }
  }

  return screenshots;
}

function collectCardFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      if (entry.name.endsWith("-data.json")) continue;
      files.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      files.push(...collectCardFiles(path.join(dir, entry.name)));
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (!opts.card && !opts.batch && !opts.discover) {
    console.error("Error: Provide --card <path>, --batch <dir>, or --discover");
    printHelp();
    process.exit(1);
  }

  if (!opts.discover) {
    fs.mkdirSync(opts.output, { recursive: true });
  }

  console.log(`Launching browser (${opts.headed ? "headed" : "headless"})...`);
  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });

  // Inject our Monaco extraction script before the page loads
  await context.addInitScript(MONACO_INIT_SCRIPT);

  const page = await context.newPage();

  try {
    console.log(`Navigating to ${DESIGNER_URL}...`);
    await page.goto(DESIGNER_URL, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeout,
    });
    await waitForDesignerReady(page, opts.timeout);

    if (opts.discover) {
      await discoverDOM(page);
      if (opts.headed) {
        console.log("Browser open for inspection. Press Ctrl+C to exit.");
        await new Promise(() => {});
      }
      return;
    }

    let allScreenshots = [];

    if (opts.card) {
      const cardPath = path.resolve(opts.card);
      if (!fs.existsSync(cardPath)) {
        console.error(`File not found: ${cardPath}`);
        process.exit(1);
      }
      allScreenshots = await processCard(page, cardPath, opts);
    } else if (opts.batch) {
      const batchDir = path.resolve(opts.batch);
      if (!fs.existsSync(batchDir)) {
        console.error(`Directory not found: ${batchDir}`);
        process.exit(1);
      }
      const files = collectCardFiles(batchDir);
      console.log(`Found ${files.length} card files in ${batchDir}`);
      for (const file of files) {
        const screenshots = await processCard(page, file, opts);
        allScreenshots.push(...screenshots);
      }
    }

    console.log(`\n=== Done ===`);
    console.log(`Screenshots captured: ${allScreenshots.length}`);
    console.log(`Output directory: ${opts.output}`);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    if (opts.headed) {
      console.log("Browser open for debugging. Press Ctrl+C to exit.");
      await new Promise(() => {});
    }
    process.exit(1);
  } finally {
    if (!opts.headed || !opts.discover) {
      await browser.close();
    }
  }
}

main();
