# adaptive-card-preview

Playwright-based tool that captures rendered Adaptive Card snapshots from the official [Microsoft Adaptive Cards Designer](https://adaptivecards.microsoft.com/designer).

Feed it a card JSON file, and it screenshots the rendered output across every combination of width preset and theme — using the **exact same renderer** as the official Designer.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
# Single card — captures all width x theme combos (8 screenshots)
node card-preview.js --card ./my-card.json

# Specific width + theme
node card-preview.js --card ./my-card.json --width narrow --theme dark

# Batch all cards in a directory
node card-preview.js --batch ./test-cards/

# Interactive mode (opens browser)
node card-preview.js --card ./my-card.json --headed

# Inspect the Designer DOM (for debugging selectors)
node card-preview.js --discover --headed
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--card <path>` | Path to a single card JSON file | — |
| `--batch <dir>` | Directory of card JSON files to process | — |
| `--width <preset>` | `verynarrow` \| `narrow` \| `standard` \| `wide` | all four |
| `--theme <mode>` | `light` \| `dark` | both |
| `--output <dir>` | Output directory for screenshots | `./snapshots` |
| `--headed` | Show the browser window | headless |
| `--discover` | Log Designer DOM structure | — |
| `--timeout <ms>` | Page load timeout | 30000 |

## Output

Screenshots are saved as `<card-name>-<width>-<theme>.png`:

```
snapshots/
  simple-text-verynarrow-light.png
  simple-text-verynarrow-dark.png
  simple-text-narrow-light.png
  simple-text-narrow-dark.png
  simple-text-standard-light.png
  simple-text-standard-dark.png
  simple-text-wide-light.png
  simple-text-wide-dark.png
```

## How it works

1. Launches Chromium via Playwright
2. Navigates to the official Adaptive Cards Designer
3. Injects a script that extracts the Monaco editor API from the webpack bundle
4. Sets the card JSON via Monaco's `model.setValue()`
5. Toggles width/theme via the Designer's Fluent UI toolbar dropdowns
6. Screenshots the rendered card area (`.acd-designer-cardArea`)

## Width presets

| Key | Designer label | Approximate width |
|-----|---------------|-------------------|
| `verynarrow` | Very narrow | ~280px |
| `narrow` | Narrow | ~320px |
| `standard` | Standard width | ~480px |
| `wide` | Wide | ~640px |

## Sample card JSON

```json
{
  "type": "AdaptiveCard",
  "version": "1.6",
  "$schema": "https://adaptivecards.io/schemas/adaptive-card.json",
  "body": [
    {
      "type": "TextBlock",
      "text": "Hello World",
      "size": "Large",
      "weight": "Bolder"
    }
  ]
}
```

## License

MIT
