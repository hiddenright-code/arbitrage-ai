# ArbitrageAI — Algorithmic Crypto Trading System

A full-stack quantitative trading platform integrating real-time 
market data from Binance.US, Kraken, and Coinbase with a 
regime-aware signal engine, custom backtesting framework, and 
live simulation tracking.

## Strategies
- Cross-exchange arbitrage (BinanceUS ↔ Kraken)
- Triangular arbitrage with ML cycle scoring
- Mean reversion quant trading with market regime detection

## Tech Stack
- Node.js / Express backend
- React / Vite frontend
- Tailwind CSS
- CCXT exchange library
- Custom technical indicators (RSI, Bollinger Bands, MACD, ATR, ADX)

## Key Features
- Adaptive market regime detection (Trending/Ranging/Volatile)
- Kelly Criterion position sizing
- Walk-forward backtesting with ablation testing
- Live simulation tracking for strategy validation
- Real-time dashboard with 8 analytical tabs

## Backtest Results
- 48.6% win rate across 74 trades
- Profit Factor: 1.513
- Sharpe Ratio: 5.33
- 73.9% win rate on high-confidence signals (0.75+)

## Setup
1. Clone the repo
2. Run `npm install`
3. Add your exchange API keys to `.env` (see `.env.example`)
4. Terminal 1: `node server.js`
5. Terminal 2: `npm run frontend`
6. Open `http://localhost:5173`

## Disclaimer
This is a research and educational project. 
Not financial advice. Trade at your own risk.


## PENDING TESTS:
	1. Pitch badge count decrement — Accept or decline a pitch on insider account, confirm Pitches tab badge in bottom nav decrements by 1 immediately without page reload.
	2. Declined pitch reasons visible to seeker — Decline a pitch with specific reasons on insider account, confirm seeker sees exact reasons on their matches page declined pitch card.
	3. Submitted stage red dot — Insider marks match as Submitted, confirm red notification dot appears on seeker's Matches tab in bottom nav, confirm dot clears when seeker visits matches page.
	4. Dynamic badge system — Add education + employment data to seeker profile, confirm correct badges appear on insider feed card (education degree with school abbreviation, experience years, student/recent grad if applicable, trust badges, status badges). Also confirm insider profile shows correct badges post-match.
	5. Rate limiting — Send 3 pitches as unverified seeker, confirm 4th pitch blocked with exact reset date shown. Manually add Community Verified badge in Supabase, confirm limit raises to 4. Add Portfolio Linked badge, confirm limit raises to 6.
	6. Company cooldown — Pitch 2 different insiders at same company, confirm 3rd pitch at same company blocked with cooldown end date shown.
	7. Email notifications — Using verified Resend email: pitch accepted email arrives branded correctly, pitch declined with reasons email arrives branded correctly, pipeline hired email arrives branded correctly. All three need to be tested end to end.
	8. Pipeline reminder notifications — Manually test by temporarily reducing time thresholds in check_pipeline_reminders() SQL function to minutes instead of hours, trigger cron manually, confirm 48hr in-app notification appears, 7d in-app + email fires, 14d in-app + email fires, 18d match flagged as stale + seeker in-app + insider email fires.
	9. Full account deletion — Delete a test account, confirm all rows removed from all tables: users, matches, messages, pitches, notifications, seeker_profiles, insider_profiles, portfolio_links, education, employment, badges, barakah_log, notification_settings, referral_vault.
	10. Name change logging + flagging — Change name once (confirm name_change_log row created, no flag). Change again (confirm 2nd log row, is_flagged = true on users table). Change 3rd time (allowed, 3rd log row). Attempt 4th change (blocked with error message).
	11. Feed filters with multiple profiles — Needs multiple seeker accounts with varied data: different visa statuses, work preferences, relocation preferences, locations, and education statuses. Test each filter individually and in combination. Test "No results" state and clear filters.
	12. Student badge — Create seeker with education.not_graduated = true, confirm Student badge appears on insider feed card.
	13. Recent grad badge — Create seeker with graduation_year = current year, no employment entries, not a current student, confirm Recent Grad badge appears on feed card.
	14. Match archiving full flow — Archive match from active tab, confirm disappears immediately. Switch to archived tab, confirm appears there. Open chat from archived tab, press back, confirm returns to archived tab not active. Unarchive, confirm returns to active tab. Auto-archive: mark stage as complete, confirm match moves to archived automatically.
	15. Declined pitch archive — Archive a declined pitch, confirm it disappears from active tab and does NOT appear in archived tab. Confirm data still exists in Supabase pitches table with is_archived = true.
	16. Seeker profile pause — Pause profile on seeker account. Log in as insider, confirm paused seeker no longer appears in talent feed. Log back in as seeker, confirm existing matches and chats still accessible. Confirm seeker can still pitch an insider while paused. Resume profile, confirm seeker reappears in insider feed.
	17. Branded email confirmation — Register new account with verified Resend email, confirm branded MRN confirmation email arrives with correct green header styling, tagline, and working confirmation link that redirects to onboarding.
	18. In-app notification on decline — Decline a pitch as insider, log in as seeker, confirm in-app notification appears with company name and correct message.
Auth callback error handling — Use an expired confirmation link, confirm page redirects to /register with "link expired" error message instead of spinning forever.
