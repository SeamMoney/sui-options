#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const extractorUrl = pathToFileURL('/Users/maxmohammadi/website-cloner/cloner/src/lib/tradingview_extract.mjs').href;
const { captureTradingViewReference, parseCaptureCli } = await import(extractorUrl);

const result = await captureTradingViewReference(parseCaptureCli(process.argv));
console.log(JSON.stringify(result, null, 2));
