import { testConnection } from './src/exchangeClient.js';

async function test() {
  console.log('═══════════════════════════════════════════════════');
  console.log('🔐 TESTING EXCHANGE CONNECTIONS');
  console.log('   Binance.US + Coinbase + Kraken');
  console.log('═══════════════════════════════════════════════════\n');
  
  // Test Binance.US
  console.log('1. Testing Binance.US...');
  const binanceUS = await testConnection('BinanceUS');
  console.log(`   Result: ${binanceUS.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (binanceUS.success) {
    console.log(`   Balance: $${binanceUS.balance.toFixed(2)}`);
  } else {
    console.log(`   Error: ${binanceUS.error}`);
  }
  
  console.log('');
  
  // Test Coinbase
  console.log('2. Testing Coinbase...');
  const coinbase = await testConnection('Coinbase');
  console.log(`   Result: ${coinbase.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (coinbase.success) {
    console.log(`   Balance: $${coinbase.balance.toFixed(2)}`);
  } else {
    console.log(`   Error: ${coinbase.error}`);
  }
  
  console.log('');
  
  // Test Kraken
  console.log('3. Testing Kraken...');
  const kraken = await testConnection('Kraken');
  console.log(`   Result: ${kraken.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  if (kraken.success) {
    console.log(`   Balance: $${kraken.balance.toFixed(2)}`);
  } else {
    console.log(`   Error: ${kraken.error}`);
  }
  
  console.log('\n═══════════════════════════════════════════════════');
  
  const allWork = binanceUS.success && coinbase.success && kraken.success;
  if (allWork) {
    console.log('\n🎉 ALL 3 EXCHANGES WORK! You can now run the bot.');
    console.log('   Run: npm run start');
    console.log('   Then open: http://localhost:5173');
  } else {
    console.log('\n⚠️ Some exchanges failed. Fix the errors above and try again.');
  }
}

test();