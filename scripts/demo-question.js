#!/usr/bin/env node
/** Drop a fully-loaded example question into the beadcause workspace. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { bylineFor } from '../lib/byline.js';

const cfg = loadConfig();
// Any absolute path under config.assetRoots is servable; use our own icon so the
// demo proves local-image delivery without needing a fixture.
const sampleImage = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon-512.png');
const ws = cfg.workspaces.find((w) => w.name === 'beadcause') || cfg.workspaces[0];
if (!ws) {
  console.error('no beads workspace found');
  process.exit(1);
}

const fence = '```';
const body = `We need to settle how the platform fee is calculated before the payouts
work can start. Both options are one line of code apart; the difference is who
absorbs Stripe's processing cost.

${fence}decision
question: Charge the platform fee on gross or on net?
options:
  - id: gross
    label: Gross — fee on the full charge
    hint: Simpler to reconcile, seller absorbs processing
    response: "Gross: take the platform fee on the full charge amount."
  - id: net
    label: Net — fee after Stripe's cut
    hint: Kinder to sellers, harder to forecast revenue
    response: "Net: calculate the platform fee after processing costs."
diagram: |
  graph LR
    B["Buyer $100"] --> P["Platform"]
    P -->|"gross: keeps $10"| S1["Seller $87.10"]
    P -->|"net: keeps $9.71"| S2["Seller $87.39"]
links:
  - "[Stripe application fees](https://docs.stripe.com/connect/direct-charges)"
  - label: Our payouts spreadsheet
    url: https://example.com/payouts
images:
  - PLACEHOLDER_IMAGE
${fence}

### What changes either way

| | Gross | Net |
|---|---|---|
| Platform take on $100 | $10.00 | $9.71 |
| Seller receives | $87.10 | $87.39 |
| Refund maths | simple | needs a proration |

The seller-facing docs already say "10% of the sale", which reads as gross.
`;

// Same byline as everything else this Mac files — see lib/byline.js.
const byline = bylineFor(cfg);
const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: byline };
const out = execFileSync(
  cfg.bdBin,
  [
    'create',
    '--title', 'Platform fee: gross or net?',
    '--type', 'task',
    '--priority', '1',
    '--label', 'human',
    '--description', body.replace('PLACEHOLDER_IMAGE', path.resolve(sampleImage)),
    '--json',
    '--actor', byline,
  ],
  { env, cwd: ws.dir, encoding: 'utf8' }
);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
console.log(`created ${created.id} in ${ws.name}`);
