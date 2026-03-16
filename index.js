const TelegramBot = require('node-telegram-bot-api');
const Airtable = require('airtable');
const axios = require('axios');
 
// ── Config ──
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
 .base(process.env.AIRTABLE_BASE_ID);
const TREASURY = process.env.TREASURY_WALLET;
const SINS_MINT = process.env.SINS_TOKEN_MINT || null;  // null until launch day
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',');
const MAX_POLICIES = 30;
 
// ── /help ──
bot.onText(/\/help/, (msg) => {
 bot.sendMessage(msg.chat.id, [
   'SINS Insurance Bot Commands:',
   '/buyinsurance <token> <TX> - Buy crash insurance',
   '/policies - View your active policies',
   '/autobuy <token> - Auto-insure a token',
   '/stake <amount> - Stake SINS tokens',
   '/unstake <amount> - Unstake SINS tokens',
   '/rewards - View staking rewards',
   '/treasury - Treasury dashboard',
   '/leaderboard - Top stakers & claims',
 ].join('\n'));
});
 
// ── /buyinsurance ──
bot.onText(/\/buyinsurance (\S+) (\S+)/,
 async (msg, match) => {
   const chatId = msg.chat.id;
   const [_, tokenAddr, txHash] = match;
 
   // Check active policy count
   const active = await base('Policies')
     .select({ filterByFormula: "Status='ACTIVE'" }).all();
   if (active.length >= MAX_POLICIES) {
     return bot.sendMessage(chatId,
       'Warning: Maximum active policies reached (30/30).\n'
       + 'Please wait until some policies expire.');
   }
 
   // Verify TX via Helius
   // ... (verify amount, recipient, recency)
 
   // Fetch baseline price from DexScreener
   const priceResp = await axios.get(
     `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
   const baselinePrice = priceResp.data.pairs?.[0]?.priceUsd;
   const triggerPrice = baselinePrice * 0.45; // 55% drop
 
   // Create policy in Airtable
   const policy = await base('Policies').create({
     user_telegram_id: String(msg.from.id),
     user_handle: '@' + (msg.from.username || 'anonymous'),
     token_address: tokenAddr,
     tx_hash: txHash,
     baseline_price: parseFloat(baselinePrice),
     trigger_price: triggerPrice,
     premium_paid: 0.02,
     coverage_amount: 0.1,
     status: 'ACTIVE',
     expires_at: new Date(Date.now() + 2*60*60*1000).toISOString(),
   });
 
   bot.sendMessage(chatId, [
     'Policy Created!',
     `ID: ${policy.getId()}`,
     `Token: ${tokenAddr.slice(0,8)}...`,
     `Baseline: $${baselinePrice}`,
     `Trigger: $${triggerPrice.toFixed(6)} (-55%)`,
     `Coverage: 0.1 SOL`,
     `Expires: 2h from now`,
     `Active: ${active.length + 1}/${MAX_POLICIES}`
   ].join('\n'));
});
 
// ── /policies ──
bot.onText(/\/policies/, async (msg) => {
 const userId = String(msg.from.id);
 const records = await base('Policies').select({
   filterByFormula: `AND(user_telegram_id='${userId}',
     Status='ACTIVE')`
 }).all();
 if (!records.length) {
   return bot.sendMessage(msg.chat.id, 'No active policies.');
 }
 const lines = records.map(r => {
   const f = r.fields;
   return `${r.getId()}: ${f.token_address?.slice(0,8)}...`
     + ` | $${f.baseline_price} | ${f.status}`;
 });
 bot.sendMessage(msg.chat.id,
   'Your Active Policies:\n' + lines.join('\n'));
});
 
// ── /stake (Coming Soon) ──
bot.onText(/\/stake/, (msg) => {
 bot.sendMessage(msg.chat.id,
   'SINS Staking is coming soon!\n\n'
   + 'We are building the staking pool now. '
   + 'Stakers will earn 70% of all insurance premiums.\n\n'
   + 'Follow our channel for the launch announcement.');
});
 
// ── /unstake (Coming Soon) ──
bot.onText(/\/unstake/, (msg) => {
 bot.sendMessage(msg.chat.id,
   'SINS Staking is coming soon! '
   + 'Unstaking will be available when staking launches.');
});
 
// ── /rewards (Coming Soon) ──
bot.onText(/\/rewards/, (msg) => {
 bot.sendMessage(msg.chat.id,
   'SINS Staking rewards are coming soon!\n\n'
   + 'Stakers will earn 70% of all insurance premiums, '
   + 'distributed daily. Stay tuned!');
});
 
// ── Price Monitor (runs every 5 min) ──
setInterval(async () => {
 const policies = await base('Policies').select({
   filterByFormula: "Status='ACTIVE'"
 }).all();
 
 for (const pol of policies) {
   const f = pol.fields;
   // Check expiry
   if (new Date(f.expires_at) <= new Date()) {
     await base('Policies').update(pol.getId(),
       { status: 'EXPIRED' });
     continue;
   }
   // Check price
   const resp = await axios.get(
     `https://api.dexscreener.com/latest/dex/tokens/`
     + f.token_address);
   const price = parseFloat(
     resp.data.pairs?.[0]?.priceUsd || 0);
   const dropPct = ((f.baseline_price - price)
     / f.baseline_price) * 100;
 
   if (dropPct >= 55) {
     if (!f.trigger_detected_at) {
       await base('Policies').update(pol.getId(),
         { trigger_detected_at: new Date().toISOString() });
     } else {
       const elapsed = Date.now()
         - new Date(f.trigger_detected_at).getTime();
       if (elapsed >= 30 * 60 * 1000) {
         await base('Policies').update(pol.getId(),
           { status: 'TRIGGERED' });
         // Notify admin and user
       }
     }
   } else if (f.trigger_detected_at) {
     // Price recovered: reset timer
     await base('Policies').update(pol.getId(),
       { trigger_detected_at: null });
   }
 }
}, 5 * 60 * 1000);
 
console.log('SINS Insurance Bot running!');
