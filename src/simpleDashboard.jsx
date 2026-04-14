import React, { useState, useEffect } from 'react';

const API_URL = 'http://localhost:3001';

export default function SimpleDashboard() {
  const [prices, setPrices] = useState({});
  const [balances, setBalances] = useState({});
  const [loading, setLoading] = useState(false);
  const [opportunities, setOpportunities] = useState([]);

  // Fetch prices from backend
  const fetchPrices = async () => {
    try {
      const res = await fetch(`${API_URL}/api/prices`);
      const data = await res.json();
      setPrices(data);
      
      // Find arbitrage opportunities
      const opps = [];
      const exchanges = ['BinanceUS', 'Kraken', 'Coinbase'];
      const pairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
      
      for (const pair of pairs) {
        for (const buyEx of exchanges) {
          for (const sellEx of exchanges) {
            if (buyEx === sellEx) continue;
            const ask = prices[buyEx]?.[pair]?.ask;
            const bid = prices[sellEx]?.[pair]?.bid;
            if (ask && bid && ask > 0) {
              const profit = ((bid - ask) / ask) * 100;
              if (profit > 0.03) {
                opps.push({ pair, buyEx, sellEx, ask, bid, profit: profit.toFixed(2) });
              }
            }
          }
        }
      }
      setOpportunities(opps.slice(0, 5));
    } catch (e) {
      console.error('Error fetching prices:', e);
    }
  };

  // Fetch balances from backend
  const fetchBalances = async () => {
    try {
      const res = await fetch(`${API_URL}/api/balances`);
      const data = await res.json();
      setBalances(data);
    } catch (e) {
      console.error('Error fetching balances:', e);
    }
  };

  const startScanning = () => {
    setLoading(true);
    fetchPrices();
    fetchBalances();
    const interval = setInterval(() => {
      fetchPrices();
      fetchBalances();
    }, 5000);
    return () => clearInterval(interval);
  };

  useEffect(() => {
    const interval = startScanning();
    return () => clearInterval(interval);
  }, []);

  const totalBalance = (balances.BinanceUS || 0) + (balances.Kraken || 0) + (balances.Coinbase || 0);

  return (
    <div className="bg-gray-950 min-h-screen text-white font-mono p-6">
      <h1 className="text-xl font-bold mb-4">⚡ ArbitrageAI - Live Trading</h1>
      
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-800 p-4 rounded">
          <p className="text-gray-400 text-xs">Total Balance</p>
          <p className="text-2xl font-bold text-green-400">${totalBalance.toFixed(2)}</p>
        </div>
        <div className="bg-gray-800 p-4 rounded">
          <p className="text-gray-400 text-xs">Opportunities Found</p>
          <p className="text-2xl font-bold text-yellow-400">{opportunities.length}</p>
        </div>
        <div className="bg-gray-800 p-4 rounded">
          <p className="text-gray-400 text-xs">Status</p>
          <p className="text-sm text-green-400">🟢 Scanning</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-800/50 p-3 rounded">
          <p className="text-gray-400 text-xs">Binance.US</p>
          <p className="text-lg">${(balances.BinanceUS || 0).toFixed(2)}</p>
        </div>
        <div className="bg-gray-800/50 p-3 rounded">
          <p className="text-gray-400 text-xs">Kraken</p>
          <p className="text-lg">${(balances.Kraken || 0).toFixed(2)}</p>
        </div>
        <div className="bg-gray-800/50 p-3 rounded">
          <p className="text-gray-400 text-xs">Coinbase</p>
          <p className="text-lg">${(balances.Coinbase || 0).toFixed(2)}</p>
        </div>
      </div>

      <h2 className="text-lg font-bold mb-3">📊 Live Arbitrage Opportunities</h2>
      {opportunities.length === 0 && <p className="text-gray-500">Scanning for opportunities...</p>}
      
      {opportunities.map((opp, i) => (
        <div key={i} className="bg-gray-800/50 border border-gray-700 rounded p-3 mb-2">
          <div className="flex justify-between">
            <span className="text-blue-400">{opp.pair}</span>
            <span className="text-green-400">+{opp.profit}% profit</span>
          </div>
          <p className="text-xs text-gray-400">Buy on {opp.buyEx} @ ${opp.ask} → Sell on {opp.sellEx} @ ${opp.bid}</p>
        </div>
      ))}
    </div>
  );
}