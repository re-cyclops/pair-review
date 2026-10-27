// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const path = require('node:path');
const args = process.argv.slice(2);
const index = args.indexOf('--model');
const requested = index === -1 ? 'default' : args[index + 1];
if (!['default', 'requested-a', 'requested-b'].includes(requested)) throw new Error(`Unexpected fixture model: ${requested}`);
if (!process.env.MODEL_ATTRIBUTION_FIXTURES) throw new Error('MODEL_ATTRIBUTION_FIXTURES is required');
process.env.WORKSPACE_PROVIDER_GATE = path.join(process.env.MODEL_ATTRIBUTION_FIXTURES, `${requested}.json`);
require('./workspace-provider');
