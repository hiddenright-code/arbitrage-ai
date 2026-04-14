// ─────────────────────────────────────────────────────────────
// TESTCONNECTION.JS — Run this first to verify API keys
// Run with: node src/testConnection.js
// ─────────────────────────────────────────────────────────────

import { testConnection, getAvailableExchanges } from './exchangeClient.js';
import { SETTINGS } from './config.js';

async function testAllConnections() {
  console.log('═══════════════════════════════════════════════════');
  console.log('🔐 TESTING EXCHANGE CONNECTIONS');
  console.log('═══════════════════════════════════════════════════\n');

  for (const exchange of SETTINGS.EXCHANGES) { // ← was hardcoded 'Binance', now uses config
    console.log(`Testing ${exchange}...`);
    const result = await testConnection(exchange);
    if (result.success) {
      console.log(`   ✅ Connected! USDT balance: $${result.balance.toFixed(2)}`);
    } else {
      console.log(`   ❌ Failed: ${result.error}`);
    }
    console.log('');
  }

  const available = getAvailableExchanges();
  console.log(`📡 Available exchanges: ${available.join(', ')}`);
  console.log('\n═══════════════════════════════════════════════════');
}

testAllConnections();
