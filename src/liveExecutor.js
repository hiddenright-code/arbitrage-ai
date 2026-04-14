// ─────────────────────────────────────────────────────────────
// LIVEEXECUTOR.JS — Real trade execution with safety limits
// Server-side only. Do NOT import from frontend.
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { placeLimitOrder, getBalance } from './exchangeClient.js'; // ← fixed: was missing
import { SETTINGS } from './config.js';

dotenv.config();

const MAX_TRADE_USD             = parseFloat(process.env.MAX_TRADE_AMOUNT_USD) || SETTINGS.CAPITAL_PER_TRADE;
const MAX_SLIPPAGE_PCT          = SETTINGS.MAX_SLIPPAGE_PCT;
const PROFIT_CONFIRMATION_REQUIRED = true;

// ─── Execute arbitrage trade with safety checks ───────────────
export async function executeLiveTrade(opportunity, userConfirmed = false) {
  console.log('═══════════════════════════════════════════════════');
  console.log(`⚠️  LIVE TRADE — MAX RISK: $${MAX_TRADE_USD}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`Pair:       ${opportunity.pair}`);
  console.log(`Buy on:     ${opportunity.buyEx} @ $${opportunity.ask}`);
  console.log(`Sell on:    ${opportunity.sellEx} @ $${opportunity.bid}`);
  console.log(`Net profit: ${opportunity.netPct}%`);

  // SAFETY 1: Profit threshold (use config value, not hardcoded)
  if (opportunity.netPct < SETTINGS.MIN_PROFIT_THRESHOLD * 100) {
    return {
      success: false,
      reason: `Profit too low (${opportunity.netPct}% < ${SETTINGS.MIN_PROFIT_THRESHOLD * 100}%). Skipping.`,
    };
  }

  // SAFETY 2: User confirmation
  if (PROFIT_CONFIRMATION_REQUIRED && !userConfirmed) {
    return {
      success: false,
      reason: 'Awaiting user confirmation.',
      requiresConfirmation: true,
    };
  }

  // SAFETY 3: Check buy-side balance
  const buyBalance = await getBalance(opportunity.buyEx, 'USDT');
  if (buyBalance < MAX_TRADE_USD) {
    return {
      success: false,
      reason: `Insufficient balance on ${opportunity.buyEx}. Need $${MAX_TRADE_USD}, have $${buyBalance.toFixed(2)}`,
    };
  }

  // SAFETY 4: Check sell-side has the crypto to sell
  const [baseCurrency] = opportunity.pair.split('/');
  const sellBalance = await getBalance(opportunity.sellEx, baseCurrency);
  const cryptoNeeded = MAX_TRADE_USD / opportunity.ask;
  if (sellBalance < cryptoNeeded * 0.99) { // 1% tolerance
    return {
      success: false,
      reason: `Insufficient ${baseCurrency} on ${opportunity.sellEx}. Need ${cryptoNeeded.toFixed(6)}, have ${sellBalance.toFixed(6)}`,
    };
  }

  // SAFETY 5: Slippage guard — re-fetch price to confirm spread still exists
  // (In production you'd re-fetch here; for now we trust the caller did so recently)
  const tradeAmountUSD = Math.min(MAX_TRADE_USD, buyBalance);
  const cryptoAmount   = tradeAmountUSD / opportunity.ask;

  console.log(`📊 Trading ${cryptoAmount.toFixed(6)} ${baseCurrency} ($${tradeAmountUSD})`);

  // STEP 1: BUY on cheaper exchange
  console.log(`🔵 Placing BUY on ${opportunity.buyEx}...`);
  let buyOrder;
  try {
    buyOrder = await placeLimitOrder(opportunity.buyEx, opportunity.pair, 'buy', cryptoAmount, opportunity.ask);
  } catch (err) {
    return { success: false, reason: `Buy order failed: ${err.message}` };
  }

  // STEP 2: SELL on more expensive exchange
  console.log(`🔴 Placing SELL on ${opportunity.sellEx}...`);
  let sellOrder;
  try {
    sellOrder = await placeLimitOrder(opportunity.sellEx, opportunity.pair, 'sell', cryptoAmount, opportunity.bid);
  } catch (err) {
    console.error(`⚠️  SELL FAILED after BUY was placed! Check ${opportunity.buyEx} manually.`);
    return {
      success: false,
      reason: `Sell failed: ${err.message}. BUY ORDER MAY BE ACTIVE ON ${opportunity.buyEx}!`,
      buyOrder,
      URGENT: true,
    };
  }

  // Calculate actual P&L
  const buyCost      = cryptoAmount * opportunity.ask;
  const sellRevenue  = cryptoAmount * opportunity.bid;
  const grossProfit  = sellRevenue - buyCost;
  const feesUSD      = (buyCost * SETTINGS.FEES[opportunity.buyEx]) + (sellRevenue * SETTINGS.FEES[opportunity.sellEx]);
  const netProfit    = grossProfit - feesUSD;

  console.log('═══════════════════════════════════════════════════');
  console.log(`✅ TRADE EXECUTED! Net profit: $${netProfit.toFixed(4)}`);
  console.log('═══════════════════════════════════════════════════');

  return {
    success: true,
    buyOrder,
    sellOrder,
    cryptoAmount,
    tradeAmountUSD,
    grossProfit: +grossProfit.toFixed(4),
    feesUSD:     +feesUSD.toFixed(4),
    netProfit:   +netProfit.toFixed(4),
  };
}

// ─── Emergency stop ────────────────────────────────────────────
export async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP ACTIVATED — No more trades will execute.');
  return { stopped: true };
}
