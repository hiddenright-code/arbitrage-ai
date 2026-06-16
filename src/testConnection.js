// ─────────────────────────────────────────────────────────────
// TESTCONNECTION.JS — Run this first to verify Alpaca API keys
// Run with: node src/testConnection.js
// ─────────────────────────────────────────────────────────────

import { testConnection, getMarketClock, getBrokerInfo } from './exchangeClient.js';
import { fetchMostActive } from './priceHistory.js';

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('🔐 TESTING ALPACA CONNECTION');
  console.log('═══════════════════════════════════════════════════\n');

  const info = getBrokerInfo();
  console.log(`Broker: ${info.broker} | Mode: ${info.paper ? 'PAPER' : 'LIVE'}`);
  console.log(`Trading URL: ${info.tradingUrl}\n`);

  console.log('Testing trading API (account)...');
  const result = await testConnection();
  if (result.success) {
    console.log(`   ✅ Connected!`);
    console.log(`   Account:        ${result.accountId}`);
    console.log(`   Status:         ${result.status}`);
    console.log(`   Cash:           $${result.cash.toFixed(2)}`);
    console.log(`   Buying power:   $${result.buyingPower.toFixed(2)}`);
    console.log(`   Portfolio:      $${result.portfolioValue.toFixed(2)}`);
  } else {
    console.log(`   ❌ Failed: ${result.error}`);
  }

  console.log('\nTesting market clock...');
  const clock = await getMarketClock();
  console.log(`   Market is ${clock?.is_open ? '🟢 OPEN' : '🔴 CLOSED'}`);
  if (clock?.next_open)  console.log(`   Next open:  ${clock.next_open}`);
  if (clock?.next_close) console.log(`   Next close: ${clock.next_close}`);

  console.log('\nTesting market data API (most-active stocks)...');
  const actives = await fetchMostActive(5);
  if (actives.length) {
    console.log(`   ✅ Data feed working — top 5 most active:`);
    actives.forEach((s, i) => console.log(`      ${i + 1}. ${s.symbol} — vol ${(s.volume / 1e6).toFixed(1)}M`));
  } else {
    console.log(`   ⚠️  No most-active data (check ALPACA_FEED / market hours)`);
  }

  console.log('\n═══════════════════════════════════════════════════');
}

run();
