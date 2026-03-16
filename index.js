var TelegramBot = require('node-telegram-bot-api');
var Airtable = require('airtable');
var axios = require('axios');

// Config
var bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
var base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);
var TREASURY = process.env.TREASURY_WALLET || 'NOT_SET';
var SINS_MINT = process.env.SINS_TOKEN_MINT || null;
var HELIUS_KEY = process.env.HELIUS_API_KEY || '';
var ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(function(id) { return id.trim(); });
var MAX_POLICIES = 30;
var PREMIUM_AMOUNT = 0.02;
var COVERAGE_AMOUNT = 0.1;
var LAMPORTS = 1000000000;

// In-memory pending insurance requests
var pendingInsurance = {};

console.log('SINS Bot starting... Treasury: ' + TREASURY);

// Helper: get wallet from Airtable
function getWallet(telegramId) {
  return base('Wallets').select({
    filterByFormula: "user_telegram_id='" + telegramId + "'"
  }).all().then(function(records) {
    if (records.length > 0 && records[0].fields.wallet_address) {
      return records[0].fields.wallet_address;
    }
    return null;
  }).catch(function(err) {
    console.error('getWallet error:', err.message);
    return null;
  });
}

// Helper: check token holding via Helius DAS
function checkTokenHolding(walletAddress, tokenMint) {
  if (!HELIUS_KEY) return Promise.resolve({ holds: false, error: 'No Helius key' });

  return axios.post(
    'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAssetsByOwner',
      params: {
        ownerAddress: walletAddress,
        page: 1,
        limit: 1000,
        displayOptions: { showFungible: true }
      }
    },
    { timeout: 15000 }
  ).then(function(resp) {
    var items = resp.data.result.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === tokenMint) {
        var bal = 0;
        if (items[i].token_info && items[i].token_info.balance) {
          bal = items[i].token_info.balance;
        }
        if (bal > 0) return { holds: true, balance: bal };
      }
    }
    return { holds: false };
  }).catch(function(err) {
    console.error('checkTokenHolding error:', err.message);
    return { holds: false, error: err.message };
  });
}

// Helper: check recent premium payment from wallet to treasury
function checkPremiumPayment(walletAddress) {
  if (!HELIUS_KEY) return Promise.resolve(null);

  return axios.get(
    'https://api.helius.xyz/v0/addresses/' + walletAddress + '/transactions?api-key=' + HELIUS_KEY + '&limit=10',
    { timeout: 15000 }
  ).then(function(resp) {
    var txs = resp.data || [];
    for (var i = 0; i < txs.length; i++) {
      var tx = txs[i];
      if (!tx.nativeTransfers) continue;
      for (var j = 0; j < tx.nativeTransfers.length; j++) {
        var tr = tx.nativeTransfers[j];
        if (
          tr.fromUserAccount === walletAddress &&
          tr.toUserAccount === TREASURY &&
          tr.amount >= (PREMIUM_AMOUNT * LAMPORTS * 0.95)
        ) {
          var txTime = tx.timestamp ? tx.timestamp * 1000 : 0;
          if (Date.now() - txTime < 30 * 60 * 1000) {
            return { confirmed: true, txHash: tx.signature, amount: tr.amount / LAMPORTS };
          }
        }
      }
    }
    return null;
  }).catch(function(err) {
    console.error('checkPremiumPayment error:', err.message);
    return null;
  });
}

// Helper: check if TX hash already used
function isTxUsed(txHash) {
  return base('Policies').select({
    filterByFormula: "tx_hash='" + txHash + "'"
  }).all().then(function(records) {
    return records.length > 0;
  }).catch(function(err) {
    console.error('isTxUsed error:', err.message);
    return false;
  });
}

// Helper: count active policies
function getActivePolicyCount() {
  return base('Policies').select({
    filterByFormula: "status='ACTIVE'"
  }).all().then(function(records) {
    return records.length;
  }).catch(function(err) {
    console.error('getActivePolicyCount error:', err.message);
    return 0;
  });
}

// /start
bot.onText(/\/start/, function(msg) {
  bot.sendMessage(msg.chat.id,
    '🛡️ Welcome to SINS Insurance Bot!\n\n'
    + 'Protect your memecoin buys against crashes.\n'
    + 'Pay ' + PREMIUM_AMOUNT + ' SOL, get ' + COVERAGE_AMOUNT + ' SOL if your token drops 55%+.\n\n'
    + 'Step 1: /wallet <your_solana_address>\n'
    + 'Step 2: /buyinsurance <token_address>\n\n'
    + 'Type /help for all commands.');
});

// /help
bot.onText(/\/help/, function(msg) {
  bot.sendMessage(msg.chat.id,
    '🛡️ SINS Insurance Bot\n\n'
    + '👛 Wallet:\n'
    + '/wallet <address> - Register wallet\n'
    + '/mywallet - View registered wallet\n\n'
    + '📋 Insurance:\n'
    + '/buyinsurance <token> - Insure a token you hold\n'
    + '/confirm - Auto-check premium payment\n'
    + '/txhash <hash> - Submit premium TX manually\n'
    + '/policies - View active policies\n\n'
    + '💰 Staking (Coming Soon):\n'
    + '/stake /unstake /rewards\n\n'
    + '📊 Info:\n'
    + '/treasury - Dashboard\n'
    + '/leaderboard - Top claims\n\n'
    + 'Not financial advice. Use at your own risk.');
});

// /wallet
bot.onText(/\/wallet(?:\s+(\S+))?/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = String(msg.from.id);
  var wallet = match[1];

  if (!wallet) {
    bot.sendMessage(chatId,
      '❌ Usage: /wallet <solana_address>\n\n'
      + 'Copy your address from Phantom and paste it here.');
    return;
  }

  if (wallet.length < 32 || wallet.length > 44) {
    bot.sendMessage(chatId, '❌ Invalid Solana address. Should be 32-44 characters.');
    return;
  }

  base('Wallets').select({
    filterByFormula: "user_telegram_id='" + userId + "'"
  }).all().then(function(existing) {
    if (existing.length > 0) {
      return base('Wallets').update(existing[0].getId(), {
        wallet_address: wallet,
        updated_at: new Date().toISOString()
      });
    } else {
      return base('Wallets').create({
        user_telegram_id: userId,
        user_handle: '@' + (msg.from.username || 'anonymous'),
        wallet_address: wallet,
        created_at: new Date().toISOString()
      });
    }
  }).then(function() {
    bot.sendMessage(chatId,
      '✅ Wallet registered!\n\n'
      + '👛 ' + wallet.slice(0, 6) + '...' + wallet.slice(-4) + '\n\n'
      + 'Now use /buyinsurance <token_address>');
  }).catch(function(err) {
    console.error('wallet error:', err.message);
    bot.sendMessage(chatId, '❌ Failed to register. Try again.');
  });
});

// /mywallet
bot.onText(/\/mywallet/, function(msg) {
  var chatId = msg.chat.id;
  getWallet(String(msg.from.id)).then(function(wallet) {
    if (wallet) {
      bot.sendMessage(chatId, '👛 Your wallet:\n' + wallet + '\n\nChange: /wallet <new>');
    } else {
      bot.sendMessage(chatId, '❌ No wallet registered.\nUse /wallet <address>');
    }
  });
});

// /buyinsurance
bot.onText(/\/buyinsurance(?:\s+(\S+))?/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = String(msg.from.id);
  var tokenAddr = match[1];

  if (!tokenAddr) {
    bot.sendMessage(chatId,
      '❌ Usage: /buyinsurance <token_address>\n\n'
      + 'Paste the contract address of the token you want to insure.');
    return;
  }

  getWallet(userId).then(function(wallet) {
    if (!wallet) {
      bot.sendMessage(chatId,
        '❌ No wallet registered!\n'
        + 'First: /wallet <your_solana_address>\n'
        + 'Then: /buyinsurance <token_address>');
      return;
    }

    bot.sendMessage(chatId, '🔍 Checking your wallet for token holdings...');

    checkTokenHolding(wallet, tokenAddr).then(function(holding) {
      if (!holding.holds) {
        bot.sendMessage(chatId,
          '❌ Token not found in your wallet.\n\n'
          + '👛 Wallet: ' + wallet.slice(0, 6) + '...' + wallet.slice(-4) + '\n'
          + '🪙 Token: ' + tokenAddr.slice(0, 8) + '...' + tokenAddr.slice(-4) + '\n\n'
          + 'You must hold this token to insure it.\n'
          + 'Buy the token first, then try again.\n\n'
          + 'Wrong wallet? /wallet <address>');
        return;
      }

      getActivePolicyCount().then(function(activeCount) {
        if (activeCount >= MAX_POLICIES) {
          bot.sendMessage(chatId,
            '⚠️ Max policies reached (' + MAX_POLICIES + '/' + MAX_POLICIES + ').\n'
            + 'Wait for some to expire.');
          return;
        }

        axios.get(
          'https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr,
          { timeout: 10000 }
        ).then(function(priceResp) {
          var pairs = priceResp.data.pairs;
          var baselinePrice = 0;
          if (pairs && pairs.length > 0) {
            baselinePrice = parseFloat(pairs[0].priceUsd);
          }

          if (baselinePrice <= 0) {
            bot.sendMessage(chatId,
              '❌ Could not fetch price.\n'
              + 'Make sure token has trading pairs on a Solana DEX.');
            return;
          }

          var triggerPrice = baselinePrice * 0.45;

          pendingInsurance[userId] = {
            tokenAddress: tokenAddr,
            wallet: wallet,
            baselinePrice: baselinePrice,
            triggerPrice: triggerPrice,
            requestedAt: Date.now(),
            chatId: chatId
          };

          bot.sendMessage(chatId,
            '✅ Token verified in your wallet!\n\n'
            + '📋 Insurance Details:\n'
            + '🪙 Token: ' + tokenAddr.slice(0, 8) + '...' + tokenAddr.slice(-4) + '\n'
            + '📈 Price: $' + baselinePrice.toFixed(8) + '\n'
            + '📉 Trigger: $' + triggerPrice.toFixed(8) + ' (-55%)\n'
            + '💰 Coverage: ' + COVERAGE_AMOUNT + ' SOL\n'
            + '⏰ Protection: 2 hours\n'
            + '💳 Premium: ' + PREMIUM_AMOUNT + ' SOL\n\n'
            + '━━━━━━━━━━━━━━━━━━━━\n'
            + '💸 Send ' + PREMIUM_AMOUNT + ' SOL to:\n\n'
            + TREASURY + '\n\n'
            + '━━━━━━━━━━━━━━━━━━━━\n\n'
            + 'After sending:\n'
            + '/confirm - auto-detect payment\n'
            + '/txhash <hash> - submit manually\n\n'
            + '⏰ 15 min to pay.');

        }).catch(function(err) {
          console.error('DexScreener error:', err.message);
          bot.sendMessage(chatId, '❌ Price fetch failed. Try again.');
        });
      });
    });
  });
});

// /confirm - auto detect payment
bot.onText(/\/confirm/, function(msg) {
  var chatId = msg.chat.id;
  var userId = String(msg.from.id);

  var pending = pendingInsurance[userId];
  if (!pending) {
    bot.sendMessage(chatId, '❌ No pending request. Use /buyinsurance first.');
    return;
  }

  if (Date.now() - pending.requestedAt > 15 * 60 * 1000) {
    delete pendingInsurance[userId];
    bot.sendMessage(chatId, '❌ Request expired (15 min). Use /buyinsurance again.');
    return;
  }

  bot.sendMessage(chatId, '🔍 Checking for payment...');

  checkPremiumPayment(pending.wallet).then(function(payment) {
    if (!payment) {
      bot.sendMessage(chatId,
        '❌ Payment not found yet.\n\n'
        + 'Send ' + PREMIUM_AMOUNT + ' SOL to:\n' + TREASURY + '\n\n'
        + 'Wait 1-2 min, then /confirm again.\n'
        + 'Or: /txhash <your_tx_hash>');
      return;
    }

    isTxUsed(payment.txHash).then(function(used) {
      if (used) {
        bot.sendMessage(chatId, '❌ That TX already used for another policy.\nSend a new payment.');
        return;
      }
      createPolicy(userId, msg.from.username, pending, payment.txHash, chatId);
    });
  });
});

// /txhash - manual TX submission
bot.onText(/\/txhash(?:\s+(\S+))?/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = String(msg.from.id);
  var txHash = match[1];

  var pending = pendingInsurance[userId];
  if (!pending) {
    bot.sendMessage(chatId, '❌ No pending request. Use /buyinsurance first.');
    return;
  }

  if (!txHash) {
    bot.sendMessage(chatId, '❌ Usage: /txhash <transaction_hash>');
    return;
  }

  if (Date.now() - pending.requestedAt > 15 * 60 * 1000) {
    delete pendingInsurance[userId];
    bot.sendMessage(chatId, '❌ Request expired. Use /buyinsurance again.');
    return;
  }

  isTxUsed(txHash).then(function(used) {
    if (used) {
      bot.sendMessage(chatId, '❌ TX hash already used for another policy.');
      return;
    }

    bot.sendMessage(chatId, '🔍 Verifying transaction...');

    if (HELIUS_KEY) {
      axios.get(
        'https://api.helius.xyz/v0/transactions/' + txHash + '?api-key=' + HELIUS_KEY,
        { timeout: 15000 }
      ).then(function(resp) {
        if (!resp.data) {
          bot.sendMessage(chatId, '❌ TX not found. Wait a minute and try again.');
          return;
        }

        var verified = false;
        var transfers = resp.data.nativeTransfers || [];
        for (var i = 0; i < transfers.length; i++) {
          if (
            transfers[i].fromUserAccount === pending.wallet &&
            transfers[i].toUserAccount === TREASURY &&
            transfers[i].amount >= (PREMIUM_AMOUNT * LAMPORTS * 0.95)
          ) {
            verified = true;
            break;
          }
        }

        if (!verified) {
          bot.sendMessage(chatId,
            '❌ TX does not match.\n'
            + 'Expected ' + PREMIUM_AMOUNT + ' SOL from your wallet to treasury.\n'
            + 'Check and try again.');
          return;
        }

        createPolicy(userId, msg.from.username, pending, txHash, chatId);

      }).catch(function(err) {
        console.error('TX verify error:', err.message);
        createPolicy(userId, msg.from.username, pending, txHash, chatId);
      });
    } else {
      createPolicy(userId, msg.from.username, pending, txHash, chatId);
    }
  });
});

// Create policy (shared function)
function createPolicy(userId, username, pending, txHash, chatId) {
  var expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  getActivePolicyCount().then(function(activeCount) {
    return base('Policies').create({
      user_telegram_id: userId,
      user_handle: '@' + (username || 'anonymous'),
      wallet_address: pending.wallet,
      token_address: pending.tokenAddress,
      tx_hash: txHash,
      baseline_price: pending.baselinePrice,
      trigger_price: pending.triggerPrice,
      premium_paid: PREMIUM_AMOUNT,
      coverage_amount: COVERAGE_AMOUNT,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      expires_at: expiresAt
    }).then(function(policy) {
      var policyId = policy.getId();

      base('Premiums').create({
        policy_id: policyId,
        amount_sol: PREMIUM_AMOUNT,
        tx_hash: txHash,
        received_at: new Date().toISOString()
      }).catch(function(err) {
        console.error('Premium record error:', err.message);
      });

      delete pendingInsurance[userId];

      bot.sendMessage(chatId,
        '✅ Policy Created!\n\n'
        + '🆔 ' + policyId + '\n'
        + '🪙 ' + pending.tokenAddress.slice(0, 8) + '...' + pending.tokenAddress.slice(-4) + '\n'
        + '📈 Baseline: $' + pending.baselinePrice.toFixed(8) + '\n'
        + '📉 Trigger: $' + pending.triggerPrice.toFixed(8) + ' (-55%)\n'
        + '💰 Coverage: ' + COVERAGE_AMOUNT + ' SOL\n'
        + '⏰ Expires: 2h\n'
        + '📊 Active: ' + (activeCount + 1) + '/' + MAX_POLICIES);

      for (var i = 0; i < ADMIN_IDS.length; i++) {
        if (ADMIN_IDS[i]) {
          bot.sendMessage(ADMIN_IDS[i],
            '📋 New Policy: ' + policyId + '\n'
            + 'User: @' + (username || '?') + '\n'
            + 'Token: ' + pending.tokenAddress.slice(0, 8) + '...\n'
            + 'Active: ' + (activeCount + 1) + '/' + MAX_POLICIES);
        }
      }
    });
  }).catch(function(err) {
    console.error('createPolicy error:', err.message);
    bot.sendMessage(chatId, '❌ Failed to create policy. Try again.');
  });
}

// /policies
bot.onText(/\/policies/, function(msg) {
  var chatId = msg.chat.id;
  var userId = String(msg.from.id);

  base('Policies').select({
    filterByFormula: "AND(user_telegram_id='" + userId + "', status='ACTIVE')"
  }).all().then(function(records) {
    if (records.length === 0) {
      bot.sendMessage(chatId, '📋 No active policies.\nUse /buyinsurance to get covered!');
      return;
    }
    var text = '📋 Your Active Policies:\n\n';
    for (var i = 0; i < records.length; i++) {
      var f = records[i].fields;
      text += '🆔 ' + records[i].getId() + '\n'
        + '   Token: ' + (f.token_address || '').slice(0, 8) + '...\n'
        + '   Coverage: ' + (f.coverage_amount || 0.1) + ' SOL\n'
        + '   Expires: ' + (f.expires_at || '?') + '\n\n';
    }
    bot.sendMessage(chatId, text);
  }).catch(function(err) {
    console.error('policies error:', err.message);
    bot.sendMessage(chatId, '❌ Could not fetch policies.');
  });
});

// Staking - Coming Soon
bot.onText(/\/stake/, function(msg) {
  bot.sendMessage(msg.chat.id, '🔜 Staking coming soon! Stakers will earn 70% of premiums.');
});
bot.onText(/\/unstake/, function(msg) {
  bot.sendMessage(msg.chat.id, '🔜 Staking coming soon!');
});
bot.onText(/\/rewards/, function(msg) {
  bot.sendMessage(msg.chat.id, '🔜 Staking rewards coming soon! 70% of premiums distributed daily.');
});

// /treasury
bot.onText(/\/treasury/, function(msg) {
  var chatId = msg.chat.id;
  var totalPremiums = 0;
  var totalPayouts = 0;
  var activeCount = 0;

  base('Policies').select({ filterByFormula: "status='ACTIVE'" }).all()
  .then(function(active) {
    activeCount = active.length;
    return base('Premiums').select().all();
  }).then(function(premiums) {
    for (var i = 0; i < premiums.length; i++) {
      totalPremiums += (premiums[i].fields.amount_sol || 0);
    }
    return base('Payouts').select().all();
  }).then(function(payouts) {
    for (var i = 0; i < payouts.length; i++) {
      totalPayouts += (payouts[i].fields.amount_sol || 0);
    }
    bot.sendMessage(chatId,
      '🏦 SINS Treasury\n\n'
      + '💰 Premiums: ' + totalPremiums.toFixed(4) + ' SOL\n'
      + '💸 Claims Paid: ' + totalPayouts.toFixed(4) + ' SOL\n'
      + '📊 Active: ' + activeCount + '/' + MAX_POLICIES + '\n'
      + '🔜 Staking: Coming Soon\n\n'
      + '🔗 ' + TREASURY);
  }).catch(function(err) {
    console.error('treasury error:', err.message);
    bot.sendMessage(chatId, '❌ Could not load treasury data.');
  });
});

// /leaderboard
bot.onText(/\/leaderboard/, function(msg) {
  var chatId = msg.chat.id;

  base('Payouts').select().all().then(function(payouts) {
    var map = {};
    for (var i = 0; i < payouts.length; i++) {
      var h = payouts[i].fields.recipient_handle || 'anon';
      if (!map[h]) map[h] = { claims: 0, total: 0 };
      map[h].claims++;
      map[h].total += (payouts[i].fields.amount_sol || 0);
    }

    var text = '🏆 SINS Leaderboard\n\n📊 Top Stakers: Coming Soon!\n\n';
    var sorted = Object.entries(map).sort(function(a, b) { return b[1].total - a[1].total; }).slice(0, 5);
    if (sorted.length > 0) {
      text += '🎯 Top Claimants:\n';
      for (var i = 0; i < sorted.length; i++) {
        text += (i+1) + '. ' + sorted[i][0] + ' - ' + sorted[i][1].claims + ' claims (' + sorted[i][1].total.toFixed(2) + ' SOL)\n';
      }
    } else {
      text += '🎯 No claims yet! Be first: /buyinsurance';
    }
    bot.sendMessage(chatId, text);
  }).catch(function(err) {
    console.error('leaderboard error:', err.message);
    bot.sendMessage(chatId, '❌ Could not load leaderboard.');
  });
});

// Admin: /payclaim
bot.onText(/\/payclaim(?:\s+(\S+))?/, function(msg, match) {
  var chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(msg.from.id))) {
    bot.sendMessage(chatId, '❌ Admin only.'); return;
  }
  var pid = match[1];
  if (!pid) { bot.sendMessage(chatId, '❌ Usage: /payclaim <policy_id>'); return; }

  base('Policies').select({ filterByFormula: "RECORD_ID()='" + pid + "'" }).all()
  .then(function(records) {
    if (records.length === 0) { bot.sendMessage(chatId, '❌ Not found: ' + pid); return; }
    var f = records[0].fields;
    if (f.status !== 'TRIGGERED') {
      bot.sendMessage(chatId, '❌ Status is "' + f.status + '". Need TRIGGERED.'); return;
    }

    base('Policies').update(pid, { status: 'PAID' }).then(function() {
      return base('Payouts').create({
        policy_id: pid,
        recipient_handle: f.user_handle || 'anon',
        amount_sol: f.coverage_amount || COVERAGE_AMOUNT,
        paid_at: new Date().toISOString()
      });
    }).then(function() {
      bot.sendMessage(chatId,
        '✅ Approved!\n' + pid + '\nSend ' + (f.coverage_amount || COVERAGE_AMOUNT) + ' SOL to:\n' + (f.wallet_address || '?'));
      if (f.user_telegram_id) {
        bot.sendMessage(f.user_telegram_id,
          '🎉 Claim approved!\nPolicy: ' + pid + '\nPayout: ' + (f.coverage_amount || COVERAGE_AMOUNT) + ' SOL incoming!');
      }
    });
  }).catch(function(err) {
    console.error('payclaim error:', err.message);
    bot.sendMessage(chatId, '❌ Error. Check logs.');
  });
});

// Admin: /stats
bot.onText(/\/stats/, function(msg) {
  var chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(msg.from.id))) {
    bot.sendMessage(chatId, '❌ Admin only.'); return;
  }

  Promise.all([
    base('Policies').select().all(),
    base('Wallets').select().all()
  ]).then(function(results) {
    var policies = results[0];
    var wallets = results[1];
    var a=0, t=0, p=0, e=0;
    for (var i = 0; i < policies.length; i++) {
      var s = policies[i].fields.status;
      if (s==='ACTIVE') a++; else if (s==='TRIGGERED') t++;
      else if (s==='PAID') p++; else if (s==='EXPIRED') e++;
    }
    bot.sendMessage(chatId,
      '📊 Stats\nWallets: ' + wallets.length + '\nPolicies: ' + policies.length
      + '\nActive: ' + a + '\nTriggered: ' + t + '\nPaid: ' + p + '\nExpired: ' + e);
  }).catch(function(err) {
    console.error('stats error:', err.message);
    bot.sendMessage(chatId, '❌ Error.');
  });
});

// Price Monitor - every 5 min
setInterval(function() {
  console.log('[Monitor] Checking prices...');

  base('Policies').select({ filterByFormula: "status='ACTIVE'" }).all()
  .then(function(policies) {
    console.log('[Monitor] Active:', policies.length);

    var chain = Promise.resolve();
    for (var p = 0; p < policies.length; p++) {
      (function(pol) {
        chain = chain.then(function() {
          var f = pol.fields;
          var polId = pol.getId();

          if (f.expires_at && new Date(f.expires_at) <= new Date()) {
            console.log('[Monitor] Expiring:', polId);
            return base('Policies').update(polId, { status: 'EXPIRED' }).then(function() {
              if (f.user_telegram_id) {
                bot.sendMessage(f.user_telegram_id,
                  '⏰ Policy expired: ' + polId + '\nNo crash detected. /buyinsurance for new coverage.');
              }
            });
          }

          if (!f.token_address || !f.baseline_price) return Promise.resolve();

          return axios.get(
            'https://api.dexscreener.com/latest/dex/tokens/' + f.token_address,
            { timeout: 10000 }
          ).then(function(resp) {
            var pairs = resp.data.pairs;
            if (!pairs || pairs.length === 0) return;
            var price = parseFloat(pairs[0].priceUsd);
            if (price <= 0) return;

            var drop = ((f.baseline_price - price) / f.baseline_price) * 100;

            if (drop >= 55) {
              if (!f.trigger_detected_at) {
                console.log('[Monitor] Drop:', polId, drop.toFixed(1) + '%');
                return base('Policies').update(polId, { trigger_detected_at: new Date().toISOString() });
              }
              var elapsed = Date.now() - new Date(f.trigger_detected_at).getTime();
              if (elapsed >= 30 * 60 * 1000) {
                console.log('[Monitor] TRIGGERED:', polId);
                return base('Policies').update(polId, { status: 'TRIGGERED' }).then(function() {
                  if (f.user_telegram_id) {
                    bot.sendMessage(f.user_telegram_id,
                      '🚨 Insurance Triggered!\n' + polId + '\nDrop: ' + drop.toFixed(1) + '%\nPayout: ' + COVERAGE_AMOUNT + ' SOL coming!');
                  }
                  for (var a = 0; a < ADMIN_IDS.length; a++) {
                    if (ADMIN_IDS[a]) {
                      bot.sendMessage(ADMIN_IDS[a],
                        '⚠️ TRIGGERED: ' + polId + '\nUser: ' + (f.user_handle||'?') + '\nDrop: ' + drop.toFixed(1) + '%\n/payclaim ' + polId);
                    }
                  }
                });
              }
            } else if (f.trigger_detected_at) {
              return base('Policies').update(polId, { trigger_detected_at: null });
            }
          }).catch(function(err) {
            console.error('[Monitor] Error:', polId, err.message);
          }).then(function() {
            return new Promise(function(resolve) { setTimeout(resolve, 1000); });
          });
        });
      })(policies[p]);
    }

    return chain;
  }).catch(function(err) {
    console.error('[Monitor] Error:', err.message);
  });
}, 5 * 60 * 1000);

// Error handling
bot.on('polling_error', function(err) { console.error('Poll error:', err.message); });
process.on('unhandledRejection', function(err) { console.error('Unhandled:', err.message); });

console.log('SINS Insurance Bot running!');
