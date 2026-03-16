const TelegramBot = require(‘node-telegram-bot-api’);
const Airtable = require(‘airtable’);
const axios = require(‘axios’);

// ── Config ──
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
.base(process.env.AIRTABLE_BASE_ID);
const TREASURY = process.env.TREASURY_WALLET || ‘NOT_SET’;
const SINS_MINT = process.env.SINS_TOKEN_MINT || null;
const HELIUS_KEY = process.env.HELIUS_API_KEY || null;
const ADMIN_IDS = (process.env.ADMIN_IDS || ‘’).split(’,’).map(id => id.trim());
const MAX_POLICIES = 30;
const TOKEN_LIVE = !!SINS_MINT && SINS_MINT !== ‘PENDING’;

console.log(‘SINS Insurance Bot starting…’);
console.log(‘Treasury:’, TREASURY);
console.log(‘Token live:’, TOKEN_LIVE);

// ── /start ──
bot.onText(//start/, (msg) => {
bot.sendMessage(msg.chat.id,
‘🛡️ Welcome to SINS Insurance Bot!\n\n’
+ ‘Protect your memecoin buys against crashes.\n’
+ ‘Pay 0.02 SOL premium, get 0.1 SOL if your token drops 55%+.\n\n’
+ ‘Type /help to see all commands.’);
});

// ── /help ──
bot.onText(//help/, (msg) => {
bot.sendMessage(msg.chat.id,
‘🛡️ SINS Insurance Bot Commands:\n\n’
+ ‘📋 Insurance:\n’
+ ‘/buyinsurance <token> <TX> - Buy crash insurance\n’
+ ‘/policies - View your active policies\n’
+ ‘/autobuy <token> - Auto-insure a token\n\n’
+ ‘💰 Staking (Coming Soon):\n’
+ ‘/stake <amount> - Stake SINS tokens\n’
+ ‘/unstake <amount> - Unstake SINS tokens\n’
+ ‘/rewards - View staking rewards\n\n’
+ ‘📊 Info:\n’
+ ‘/treasury - Treasury dashboard\n’
+ ‘/leaderboard - Top claims\n’
+ ‘/help - This message\n\n’
+ ‘⚠️ SINS Insurance is experimental DeFi. Not regulated. Use at your own risk.’);
});

// ── /buyinsurance ──
bot.onText(//buyinsurance(?:\s+(\S+)\s+(\S+))?/, async (msg, match) => {
const chatId = msg.chat.id;

try {
const tokenAddr = match[1];
const txHash = match[2];

```
if (!tokenAddr || !txHash) {
  return bot.sendMessage(chatId,
    '❌ Usage: /buyinsurance <token_address> <TX_hash>\n\n'
    + 'Example:\n'
    + '/buyinsurance So1abc...xyz 4kTx...abc\n\n'
    + 'Steps:\n'
    + '1. Send 0.02 SOL to treasury: ' + TREASURY + '\n'
    + '2. Copy the transaction hash\n'
    + '3. Run the command above with the token and TX hash');
}

// Check active policy count
let active = [];
try {
  active = await base('Policies')
    .select({ filterByFormula: "status='ACTIVE'" })
    .all();
} catch (err) {
  console.error('Airtable read error:', err.message);
}

if (active.length >= MAX_POLICIES) {
  return bot.sendMessage(chatId,
    '⚠️ Maximum active policies reached (' + MAX_POLICIES + '/' + MAX_POLICIES + ').\n'
    + 'Please wait until some policies expire.');
}

// Verify TX via Helius (if API key available)
if (HELIUS_KEY) {
  try {
    const txResp = await axios.get(
      'https://api.helius.xyz/v0/transactions/' + txHash + '?api-key=' + HELIUS_KEY,
      { timeout: 10000 }
    );
    // Basic verification - check TX exists and succeeded
    if (!txResp.data || txResp.data.type === 'UNKNOWN') {
      return bot.sendMessage(chatId,
        '❌ Transaction not found or not confirmed yet.\n'
        + 'Wait a minute and try again.');
    }
  } catch (err) {
    console.error('Helius verification error:', err.message);
    // Continue anyway - manual verification can be done later
  }
}

// Check if TX hash already used
try {
  const existing = await base('Policies')
    .select({ filterByFormula: "tx_hash='" + txHash + "'" })
    .all();
  if (existing.length > 0) {
    return bot.sendMessage(chatId,
      '❌ This transaction hash has already been used for policy '
      + existing[0].get('policy_id') + '.');
  }
} catch (err) {
  console.error('Duplicate check error:', err.message);
}

// Fetch baseline price from DexScreener
let baselinePrice = 0;
try {
  const priceResp = await axios.get(
    'https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr,
    { timeout: 10000 }
  );
  const pairs = priceResp.data.pairs;
  if (pairs && pairs.length > 0) {
    baselinePrice = parseFloat(pairs[0].priceUsd);
  }
} catch (err) {
  console.error('DexScreener error:', err.message);
}

if (baselinePrice <= 0) {
  return bot.sendMessage(chatId,
    '❌ Could not fetch price for this token.\n'
    + 'Check the token address is correct and has trading pairs on a Solana DEX.');
}

const triggerPrice = baselinePrice * 0.45; // 55% drop
const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

// Create policy in Airtable
let policyId = 'POL-???';
try {
  const policy = await base('Policies').create({
    user_telegram_id: String(msg.from.id),
    user_handle: '@' + (msg.from.username || 'anonymous'),
    token_address: tokenAddr,
    tx_hash: txHash,
    baseline_price: baselinePrice,
    trigger_price: triggerPrice,
    premium_paid: 0.02,
    coverage_amount: 0.1,
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  policyId = policy.getId();
} catch (err) {
  console.error('Airtable create error:', err.message);
  return bot.sendMessage(chatId,
    '❌ Failed to create policy. Please try again or contact admin.');
}

// Record premium
try {
  await base('Premiums').create({
    policy_id: policyId,
    amount_sol: 0.02,
    tx_hash: txHash,
    received_at: new Date().toISOString(),
  });
} catch (err) {
  console.error('Premium record error:', err.message);
}

bot.sendMessage(chatId,
  '✅ Policy Created!\n\n'
  + '🆔 ID: ' + policyId + '\n'
  + '🪙 Token: ' + tokenAddr.slice(0, 8) + '...' + tokenAddr.slice(-4) + '\n'
  + '📈 Baseline: $' + baselinePrice.toFixed(8) + '\n'
  + '📉 Trigger: $' + triggerPrice.toFixed(8) + ' (-55%)\n'
  + '💰 Coverage: 0.1 SOL\n'
  + '⏰ Expires: 2h from now\n'
  + '📊 Active: ' + (active.length + 1) + '/' + MAX_POLICIES);
```

} catch (err) {
console.error(‘buyinsurance error:’, err.message);
bot.sendMessage(chatId, ‘❌ Something went wrong. Please try again.’);
}
});

// ── /policies ──
bot.onText(//policies/, async (msg) => {
const chatId = msg.chat.id;

try {
const userId = String(msg.from.id);
const records = await base(‘Policies’).select({
filterByFormula: “AND(user_telegram_id=’” + userId + “’, status=‘ACTIVE’)”
}).all();

```
if (records.length === 0) {
  return bot.sendMessage(chatId,
    '📋 You have no active policies.\n\n'
    + 'Use /buyinsurance to get covered!');
}

let text = '📋 Your Active Policies:\n\n';
for (const r of records) {
  const f = r.fields;
  text += '🆔 ' + r.getId() + '\n'
    + '   Token: ' + (f.token_address || '').slice(0, 8) + '...\n'
    + '   Baseline: $' + (f.baseline_price || 0).toFixed(8) + '\n'
    + '   Coverage: ' + (f.coverage_amount || 0.1) + ' SOL\n'
    + '   Status: ' + (f.status || 'ACTIVE') + '\n'
    + '   Expires: ' + (f.expires_at || 'unknown') + '\n\n';
}

bot.sendMessage(chatId, text);
```

} catch (err) {
console.error(‘policies error:’, err.message);
bot.sendMessage(chatId, ‘❌ Could not fetch policies. Please try again.’);
}
});

// ── /autobuy ──
bot.onText(//autobuy(?:\s+(\S+))?/, (msg, match) => {
const chatId = msg.chat.id;
const token = match[1];

if (!token) {
return bot.sendMessage(chatId,
‘❌ Usage: /autobuy <token_address>\n\n’
+ ‘This will auto-insure your next purchase of this token.’);
}

bot.sendMessage(chatId,
‘🔔 Auto-Insurance registered for:\n’
+ token.slice(0, 8) + ‘…’ + token.slice(-4) + ‘\n\n’
+ ‘⚠️ Auto-buy monitoring is coming in Phase 2.\n’
+ ‘For now, use /buyinsurance manually after each purchase.’);
});

// ── /stake (Coming Soon) ──
bot.onText(//stake/, (msg) => {
bot.sendMessage(msg.chat.id,
‘🔜 SINS Staking is coming soon!\n\n’
+ ‘We are building the staking pool now.\n’
+ ‘Stakers will earn 70% of all insurance premiums.\n\n’
+ ‘📢 Follow our channel for the launch announcement.’);
});

// ── /unstake (Coming Soon) ──
bot.onText(//unstake/, (msg) => {
bot.sendMessage(msg.chat.id,
‘🔜 SINS Staking is coming soon!\n’
+ ‘Unstaking will be available when staking launches.’);
});

// ── /rewards (Coming Soon) ──
bot.onText(//rewards/, (msg) => {
bot.sendMessage(msg.chat.id,
‘🔜 SINS Staking rewards are coming soon!\n\n’
+ ‘Stakers will earn 70% of all insurance premiums,\n’
+ ‘distributed daily. Stay tuned!’);
});

// ── /treasury ──
bot.onText(//treasury/, async (msg) => {
const chatId = msg.chat.id;

try {
let activeCount = 0;
let totalPremiums = 0;
let totalPayouts = 0;

```
try {
  const activePolicies = await base('Policies')
    .select({ filterByFormula: "status='ACTIVE'" })
    .all();
  activeCount = activePolicies.length;
} catch (err) {
  console.error('Treasury active count error:', err.message);
}

try {
  const premiums = await base('Premiums').select().all();
  for (const p of premiums) {
    totalPremiums += (p.fields.amount_sol || 0);
  }
} catch (err) {
  console.error('Treasury premiums error:', err.message);
}

try {
  const payouts = await base('Payouts').select().all();
  for (const p of payouts) {
    totalPayouts += (p.fields.amount_sol || 0);
  }
} catch (err) {
  console.error('Treasury payouts error:', err.message);
}

bot.sendMessage(chatId,
  '🏦 SINS Treasury Dashboard\n\n'
  + '💰 Premiums Collected: ' + totalPremiums.toFixed(4) + ' SOL\n'
  + '💸 Claims Paid: ' + totalPayouts.toFixed(4) + ' SOL\n'
  + '📊 Active Policies: ' + activeCount + '/' + MAX_POLICIES + '\n\n'
  + '🔜 Staking: Coming Soon\n\n'
  + '🔗 Treasury Wallet:\n' + TREASURY);
```

} catch (err) {
console.error(‘treasury error:’, err.message);
bot.sendMessage(chatId, ‘❌ Could not fetch treasury data. Please try again.’);
}
});

// ── /leaderboard ──
bot.onText(//leaderboard/, async (msg) => {
const chatId = msg.chat.id;

try {
let payoutMap = {};

```
try {
  const payouts = await base('Payouts').select().all();
  for (const p of payouts) {
    const handle = p.fields.recipient_handle || 'anonymous';
    if (!payoutMap[handle]) {
      payoutMap[handle] = { claims: 0, total: 0 };
    }
    payoutMap[handle].claims += 1;
    payoutMap[handle].total += (p.fields.amount_sol || 0);
  }
} catch (err) {
  console.error('Leaderboard payouts error:', err.message);
}

let text = '🏆 SINS Leaderboard\n\n';
text += '📊 Top Stakers: Coming Soon!\n\n';

const sorted = Object.entries(payoutMap)
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 5);

if (sorted.length > 0) {
  text += '🎯 Top Claimants:\n';
  sorted.forEach(([handle, data], i) => {
    text += (i + 1) + '. ' + handle + ' - '
      + data.claims + ' claims (' + data.total.toFixed(2) + ' SOL)\n';
  });
} else {
  text += '🎯 Top Claimants: No claims yet!\n';
  text += 'Be the first to get insured with /buyinsurance';
}

bot.sendMessage(chatId, text);
```

} catch (err) {
console.error(‘leaderboard error:’, err.message);
bot.sendMessage(chatId, ‘❌ Could not fetch leaderboard. Please try again.’);
}
});

// ── Admin: /payclaim ──
bot.onText(//payclaim(?:\s+(\S+))?/, async (msg, match) => {
const chatId = msg.chat.id;
const userId = String(msg.from.id);

if (!ADMIN_IDS.includes(userId)) {
return bot.sendMessage(chatId, ‘❌ Admin only command.’);
}

const policyId = match[1];
if (!policyId) {
return bot.sendMessage(chatId, ‘❌ Usage: /payclaim <policy_id>’);
}

try {
const records = await base(‘Policies’).select({
filterByFormula: “RECORD_ID()=’” + policyId + “’”
}).all();

```
if (records.length === 0) {
  return bot.sendMessage(chatId, '❌ Policy not found: ' + policyId);
}

const policy = records[0];
const f = policy.fields;

if (f.status !== 'TRIGGERED') {
  return bot.sendMessage(chatId,
    '❌ Policy status is "' + f.status + '". Only TRIGGERED policies can be paid.');
}

// Mark as paid
await base('Policies').update(policyId, { status: 'PAID' });

// Record payout
await base('Payouts').create({
  policy_id: policyId,
  recipient_handle: f.user_handle || 'anonymous',
  amount_sol: f.coverage_amount || 0.1,
  paid_at: new Date().toISOString(),
});

bot.sendMessage(chatId,
  '✅ Claim approved!\n\n'
  + 'Policy: ' + policyId + '\n'
  + 'Recipient: ' + (f.user_handle || 'anonymous') + '\n'
  + 'Amount: ' + (f.coverage_amount || 0.1) + ' SOL\n\n'
  + '⚠️ Now send ' + (f.coverage_amount || 0.1) + ' SOL to the user from Phantom.');

// Notify user
if (f.user_telegram_id) {
  bot.sendMessage(f.user_telegram_id,
    '🎉 Your insurance claim has been approved!\n\n'
    + 'Policy: ' + policyId + '\n'
    + 'Payout: ' + (f.coverage_amount || 0.1) + ' SOL\n\n'
    + 'The payout will be sent to your wallet shortly.');
}
```

} catch (err) {
console.error(‘payclaim error:’, err.message);
bot.sendMessage(chatId, ‘❌ Error processing claim. Check logs.’);
}
});

// ── Admin: /addpremium ──
bot.onText(//addpremium(?:\s+(\S+))?/, (msg, match) => {
const chatId = msg.chat.id;
const userId = String(msg.from.id);

if (!ADMIN_IDS.includes(userId)) {
return bot.sendMessage(chatId, ‘❌ Admin only command.’);
}

const amount = parseFloat(match[1]);
if (!amount || amount <= 0) {
return bot.sendMessage(chatId, ‘❌ Usage: /addpremium <amount_in_SOL>’);
}

bot.sendMessage(chatId,
‘✅ Noted: ’ + amount + ’ SOL added to treasury.\n’
+ ‘Update the Treasury_State table in Airtable manually.’);
});

// ── Admin: /stats ──
bot.onText(//stats/, async (msg) => {
const chatId = msg.chat.id;
const userId = String(msg.from.id);

if (!ADMIN_IDS.includes(userId)) {
return bot.sendMessage(chatId, ‘❌ Admin only command.’);
}

try {
const allPolicies = await base(‘Policies’).select().all();
const active = allPolicies.filter(p => p.fields.status === ‘ACTIVE’).length;
const triggered = allPolicies.filter(p => p.fields.status === ‘TRIGGERED’).length;
const paid = allPolicies.filter(p => p.fields.status === ‘PAID’).length;
const expired = allPolicies.filter(p => p.fields.status === ‘EXPIRED’).length;

```
bot.sendMessage(chatId,
  '📊 Admin Stats\n\n'
  + 'Total Policies: ' + allPolicies.length + '\n'
  + 'Active: ' + active + '\n'
  + 'Triggered (awaiting payout): ' + triggered + '\n'
  + 'Paid: ' + paid + '\n'
  + 'Expired: ' + expired + '\n\n'
  + 'Token Live: ' + (TOKEN_LIVE ? 'YES' : 'NO') + '\n'
  + 'SINS Mint: ' + (SINS_MINT || 'NOT SET'));
```

} catch (err) {
console.error(‘stats error:’, err.message);
bot.sendMessage(chatId, ‘❌ Could not fetch stats.’);
}
});

// ── Price Monitor (runs every 5 min) ──
setInterval(async () => {
console.log(’[Price Monitor] Running check…’);

try {
const policies = await base(‘Policies’)
.select({ filterByFormula: “status=‘ACTIVE’” })
.all();

```
console.log('[Price Monitor] Active policies:', policies.length);

for (const pol of policies) {
  const f = pol.fields;
  const polId = pol.getId();

  // Check expiry first
  if (f.expires_at && new Date(f.expires_at) <= new Date()) {
    console.log('[Price Monitor] Expiring policy:', polId);
    await base('Policies').update(polId, { status: 'EXPIRED' });

    // Notify user
    if (f.user_telegram_id) {
      bot.sendMessage(f.user_telegram_id,
        '⏰ Your insurance policy has expired.\n\n'
        + 'Policy: ' + polId + '\n'
        + 'Token: ' + (f.token_address || '').slice(0, 8) + '...\n'
        + 'No crash detected during the 2-hour window.\n\n'
        + 'Buy new coverage with /buyinsurance');
    }
    continue;
  }

  // Check price
  if (!f.token_address || !f.baseline_price) continue;

  try {
    const resp = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/' + f.token_address,
      { timeout: 10000 }
    );
    const pairs = resp.data.pairs;
    if (!pairs || pairs.length === 0) continue;

    const currentPrice = parseFloat(pairs[0].priceUsd);
    if (currentPrice <= 0) continue;

    const dropPct = ((f.baseline_price - currentPrice) / f.baseline_price) * 100;

    if (dropPct >= 55) {
      if (!f.trigger_detected_at) {
        // First detection - start 30-min timer
        console.log('[Price Monitor] Drop detected for', polId, ':', dropPct.toFixed(1) + '%');
        await base('Policies').update(polId, {
          trigger_detected_at: new Date().toISOString()
        });
      } else {
        // Check if 30 minutes have passed
        const elapsed = Date.now() - new Date(f.trigger_detected_at).getTime();
        if (elapsed >= 30 * 60 * 1000) {
          console.log('[Price Monitor] TRIGGERED policy:', polId);
          await base('Policies').update(polId, { status: 'TRIGGERED' });

          // Notify user
          if (f.user_telegram_id) {
            bot.sendMessage(f.user_telegram_id,
              '🚨 Insurance Triggered!\n\n'
              + 'Policy: ' + polId + '\n'
              + 'Token dropped ' + dropPct.toFixed(1) + '% and stayed below threshold.\n'
              + 'Payout: 0.1 SOL\n\n'
              + 'Your claim is being processed. You will be notified when payment is sent.');
          }

          // Notify admin
          for (const adminId of ADMIN_IDS) {
            if (adminId) {
              bot.sendMessage(adminId,
                '⚠️ ADMIN: Policy triggered!\n\n'
                + 'Policy: ' + polId + '\n'
                + 'User: ' + (f.user_handle || 'unknown') + '\n'
                + 'Drop: ' + dropPct.toFixed(1) + '%\n'
                + 'Payout: 0.1 SOL\n\n'
                + 'Use /payclaim ' + polId + ' to approve.');
            }
          }
        }
      }
    } else if (f.trigger_detected_at) {
      // Price recovered - reset timer
      console.log('[Price Monitor] Price recovered for', polId);
      await base('Policies').update(polId, { trigger_detected_at: null });
    }

  } catch (err) {
    console.error('[Price Monitor] Price check error for', polId, ':', err.message);
  }

  // Rate limit: wait 1 second between API calls
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

} catch (err) {
console.error(’[Price Monitor] Error:’, err.message);
}
}, 5 * 60 * 1000); // Every 5 minutes

// ── Error handling ──
bot.on(‘polling_error’, (err) => {
console.error(‘Polling error:’, err.message);
});

process.on(‘unhandledRejection’, (err) => {
console.error(‘Unhandled rejection:’, err.message);
});

console.log(‘SINS Insurance Bot is running!’);