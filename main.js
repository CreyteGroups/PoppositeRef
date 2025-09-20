// main.js - Popposite Referral Bot (full admin + user commands)
// ES Module style - Node "type": "module" required in package.json

import { Telegraf } from "telegraf";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";

// Track ongoing user actions (e.g., withdraw input)
const userSessions = {}; // { userId: { action: 'withdraw', data: {} } }

// === CONFIG ===
import "dotenv/config"; // automatically loads .env

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const MIN_WITHDRAW = 100; // minimum withdraw amount

// === DATABASE SETUP ===
const adapter = new JSONFile("db.json");
// Provide default data to Low
const db = new Low(adapter, {
    users: [],
    pendingPurchases: [], // { id, userId, package, note, createdAt }
    withdraws: [] // { id, userId, amount, status: 'pending'|'approved'|'rejected', note, createdAt, updatedAt }
});

await db.read();
db.data ||= { users: [], pendingPurchases: [], withdraws: [] };
await db.write();

// === BOT INSTANCE ===
const bot = new Telegraf(BOT_TOKEN);

// === COMMISSION TABLE & PACKAGES ===
const PACKAGES = {
    Basic: { price: 1500, commission: 200 },
    Premium: { price: 3000, commission: 400 },
    VIP: { price: 3500, commission: 500 }
};

// === HELPERS ===

function isAdmin(ctx) {
    return ctx.from?.id === ADMIN_ID; // numeric comparison
}

function findUserById(id) {
    return db.data.users.find(u => u.id === id);
}

function findUserByReferral(code) {
    return db.data.users.find(u => u.referralCode === code);
}

function listUsersSummary() {
    return db.data.users.map(u => {
        return {
            id: u.id,
            name: u.name,
            package: u.package || null,
            balance: u.balance || 0,
            referralCode: u.referralCode
        };
    });
}

// === HELPER: Create withdraw request with dynamic amount and payment method
async function createWithdrawRequestDynamic(user, amount, paymentMethod) {
    await db.read();
    if (!amount || amount <= 0) return { ok: false, error: "Invalid amount" };
    if (amount > user.balance)
        return { ok: false, error: "Insufficient balance" };
    if (amount % 100 !== 0)
        return { ok: false, error: "Amount must end with 00" };

    const request = {
        id: nanoid(8),
        userId: user.id,
        amount,
        paymentMethod,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    db.data.withdraws.push(request);
    user.balance -= amount; // deduct requested amount
    await saveDB();
    return { ok: true, request };
}

import fs from "fs"; // add this at the top
import path from "path";

import cron from "node-cron";

cron.schedule("0 * * * *", async () => {
  console.log("⏰ Scheduled backup running...");
  await saveDB();
});

// add user if not exists, return user object
async function registerUserIfNotExists(ctx, referralCode = null) {
    await db.read();
    let user = findUserById(ctx.from.id);
    if (!user) {
        user = {
            id: ctx.from.id,
            name: ctx.from.first_name || `${ctx.from.username || "User"}`,
            referralCode: nanoid(6),
            referredBy: referralCode || null,
            balance: 0,
            package: null,
            createdAt: new Date().toISOString()
        };
        db.data.users.push(user);

        // notify referrer
        if (referralCode) {
            const ref = findUserByReferral(referralCode);
            if (ref) {
                try {
                    await ctx.telegram.sendMessage(
                        ref.id,
                        `🎉 Someone joined using your referral link! User: ${user.name}`
                    );
                } catch (e) {
                    // ignore if can't message
                }
            }
        }

        await saveDB();
    }
    return user;
}

// Confirm purchase: set user's package and add commission to referrer
async function confirmPurchase(userId, packageType, note = "") {
    await db.read();
    const user = findUserById(userId);
    if (!user) return { ok: false, error: "User not found" };
    if (!PACKAGES[packageType]) return { ok: false, error: "Invalid package" };

    user.package = packageType;
    user.packageConfirmedAt = new Date().toISOString();

    // Add commission to referrer if exists
    if (user.referredBy) {
        const ref = findUserByReferral(user.referredBy);
        if (ref) {
            ref.balance = (ref.balance || 0) + PACKAGES[packageType].commission;
            // notify referrer
            try {
                await bot.telegram.sendMessage(
                    ref.id,
                    `🎉 Your referral ${user.name} purchased ${packageType}! You earned ${PACKAGES[packageType].commission} ETB. Your balance: ${ref.balance} ETB`
                );
            } catch (e) {
                // ignore send errors
            }
        }
    }

    // remove any pending purchase entries for this user/package
    db.data.pendingPurchases = db.data.pendingPurchases.filter(
        p => !(p.userId === userId && p.package === packageType)
    );

    await saveDB();
    return { ok: true, user };
}

// Create a withdraw request (user side)
async function createWithdrawRequest(user) {
    await db.read();
    const request = {
        id: nanoid(8),
        userId: user.id,
        amount: user.balance,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    db.data.withdraws.push(request);
    // reset user balance (we keep behavior: reset on request)
    user.balance = 0;
    await saveDB();
    return request;
}

// Approve a withdraw request (admin)
async function approveWithdrawRequest(withdrawId, note = "") {
    await db.read();
    const w = db.data.withdraws.find(x => x.id === withdrawId);
    if (!w) return { ok: false, error: "Withdraw request not found" };
    if (w.status !== "pending") return { ok: false, error: "Not pending" };
    w.status = "approved";
    w.updatedAt = new Date().toISOString();
    w.note = note;
    await saveDB();
    // notify user
    try {
        await bot.telegram.sendMessage(
            w.userId,
            `✅ Your withdraw request (${w.id}) of ${w.amount} ETB has been approved by admin.`
        );
    } catch (e) {}
    return { ok: true, w };
}

// Reject a withdraw request (admin)
async function rejectWithdrawRequest(withdrawId, reason = "") {
    await db.read();
    const w = db.data.withdraws.find(x => x.id === withdrawId);
    if (!w) return { ok: false, error: "Withdraw request not found" };
    if (w.status !== "pending") return { ok: false, error: "Not pending" };
    w.status = "rejected";
    w.updatedAt = new Date().toISOString();
    w.note = reason || "";
    // return amount to user balance
    const user = findUserById(w.userId);
    if (user) {
        user.balance = (user.balance || 0) + w.amount;
    }
    await saveDB();
    // notify user
    try {
        await bot.telegram.sendMessage(
            w.userId,
            `❌ Your withdraw request (${w.id}) has been rejected. Reason: ${reason}`
        );
    } catch (e) {}
    return { ok: true, w };
}

// Add pending purchase (admin) — admin can add a pending purchase after verifying payment was made
async function addPendingPurchase(userId, packageType, note = "") {
    await db.read();
    const user = findUserById(userId);
    if (!user) return { ok: false, error: "User not found" };
    if (!PACKAGES[packageType]) return { ok: false, error: "Invalid package" };
    const entry = {
        id: nanoid(8),
        userId,
        package: packageType,
        note,
        createdAt: new Date().toISOString()
    };
    db.data.pendingPurchases.push(entry);
    await saveDB();
    // notify admin (redundant since admin did it) or user
    try {
        await bot.telegram.sendMessage(
            userId,
            `📌 Your payment for ${packageType} has been recorded. Admin will confirm your package soon.`
        );
    } catch (e) {}
    return { ok: true, entry };
}

// Broadcast to all users (admin)
async function broadcastMessage(text) {
    await db.read();
    const users = db.data.users || [];
    for (const u of users) {
        try {
            await bot.telegram.sendMessage(u.id, text);
        } catch (e) {
            // ignore failed deliveries
        }
    }
    return { ok: true, count: users.length };
}

// === TELEGRAM COMMANDS ===

// Set commands menu (so users see suggestions)
await bot.telegram.setMyCommands([
    { command: "start", description: "Start & register / get referral link" },
    { command: "help", description: "Show help menu" },
    { command: "packages", description: "Show packages & prices" },
    { command: "order", description: "How to order" },
    { command: "referral", description: "Show your referral link" },
    { command: "myrefs", description: "List people you referred" },
    { command: "balance", description: "Check your balance" },
    { command: "withdraw", description: "Request withdrawal" },
    { command: "myid", description: "Show your Telegram ID" }
]);

// /start [referralCode]
bot.start(async ctx => {
    await db.read();
    const text = ctx.message?.text || "";
    const parts = text.split(" ");
    const referralCode = parts[1] || null;
    const user = await registerUserIfNotExists(ctx, referralCode);
    await ctx.reply(
        `👋 Welcome, ${user.name}!\n\nYour referral link:\nhttps://t.me/${ctx.botInfo.username}?start=${user.referralCode}\n\nUse /packages to see available website packages.`
    );
});

// /help
bot.command("help", ctx => {
    ctx.reply(
        `📖 Popposite Bot - Commands\n\nUser:\n/start - Register & get referral link\n/packages - Show packages\n/order - How to order\n/referral - Show referral link\n/myrefs - Your referred users\n/balance - Show balance\n/withdraw - Request withdrawal\n/myid - Show your Telegram ID\n\nAdmin: (owner only)\n/users, /user <id>, /add_pending <userId> <package>, /pending, /confirm <userId> <package>, /refs <userId>, /withdrawals, /approve <withdrawId>, /reject <withdrawId>, /broadcast <text>, /stats, /sales\n`
    );
});

// /packages
bot.command("packages", ctx => {
    let msg = "🧾 Packages\n\n";
    for (const key of Object.keys(PACKAGES)) {
        const p = PACKAGES[key];
        msg += `🔸 ${key} — ${p.price} ETB — Commission: ${p.commission} ETB\n`;
    }
    msg += `\nNote: Pre-payment required. Contact admin to pay and confirm.`;
    ctx.reply(msg);
});

// /order
bot.command("order", ctx => {
    ctx.reply(
        `📦 To place an order:\n1) Contact us on Telegram: Popposite Telegram (or use the contact link in our profile).\n2) Pay the pre-payment (1000 ETB) via Telebirr or bank transfer.\n3) Send payment proof to admin.\n\nAfter admin verifies payment, your package will be confirmed.\nUse /packages to choose a package.`
    );
});

// /referral
bot.command("referral", async ctx => {
    await db.read();
    const user = findUserById(ctx.from.id);
    if (!user) return ctx.reply("❌ Please /start first.");
    await ctx.reply(
        `🔗 Your referral link:\nhttps://t.me/${ctx.botInfo.username}?start=${user.referralCode}`
    );
});

// /myrefs
bot.command("myrefs", async ctx => {
    await db.read();
    const user = findUserById(ctx.from.id);
    if (!user) return ctx.reply("❌ Please /start first.");
    const refs = db.data.users.filter(u => u.referredBy === user.referralCode);
    if (!refs.length) return ctx.reply("🙅 You have no referrals yet.");
    let msg = "👥 Your referrals:\n";
    for (const r of refs) {
        msg += `- ${r.name} (ID: ${r.id}) — ${
            r.package ? r.package + " ✅" : "Pending ❌"
        }\n`;
    }
    ctx.reply(msg);
});

// /balance
bot.command("balance", async ctx => {
    await db.read();
    const user = findUserById(ctx.from.id);
    if (!user) return ctx.reply("❌ Please /start first.");
    const refs = db.data.users.filter(u => u.referredBy === user.referralCode);
    const refsText =
        refs.map(r => `- ${r.name}: ${r.package || "Pending ❌"}`).join("\n") ||
        "None";
    ctx.reply(
        `💰 Your balance: ${
            user.balance || 0
        } ETB\n\n👥 Referrals:\n${refsText}\n\n🔗 Referral link:\nhttps://t.me/${
            ctx.botInfo.username
        }?start=${user.referralCode}`
    );
});

// /withdraw - ask amount first, then payment method with cancel support
bot.command("withdraw", async ctx => {
    await db.read();
    const user = findUserById(ctx.from.id);
    if (!user) return ctx.reply("❌ Please /start first.");
    if ((user.balance || 0) < MIN_WITHDRAW)
        return ctx.reply(`⚠️ Minimum withdraw is ${MIN_WITHDRAW} ETB.`);

    userSessions[ctx.from.id] = { action: "withdraw", step: "amount" };
    ctx.reply(
        "💰 Enter the amount you want to withdraw (must end with 00), or type 'cancel' to abort."
    );
});

// Handle withdraw session input
bot.on("text", async ctx => {
    const session = userSessions[ctx.from.id];
    if (!session) return; // no session active

    const text = ctx.message.text.trim().toLowerCase();
    if (text === "cancel") {
        delete userSessions[ctx.from.id];
        return ctx.reply("❌ Withdraw canceled.");
    }

    const user = findUserById(ctx.from.id);
    if (!user) return ctx.reply("❌ User not found.");

    if (session.action === "withdraw") {
        // Step 1: Amount
        if (session.step === "amount") {
            const amount = parseInt(ctx.message.text, 10);
            if (isNaN(amount) || amount <= 0 || amount % 100 !== 0)
                return ctx.reply(
                    "⚠️ Invalid amount. Must be a number ending with 00 and greater than 0."
                );
            if (amount > user.balance)
                return ctx.reply("⚠️ Insufficient balance.");
            session.data = { amount };
            session.step = "method";
            return ctx.reply(
                "💳 Choose payment method:\n1) Telebirr\n2) CBE\n3) Transfer\nOr type 'cancel' to abort."
            );
        }

        // Step 2: Payment method
        if (session.step === "method") {
            let method;
            if (text.includes("telebirr") || text === "1") method = "Telebirr";
            else if (text.includes("cbe") || text === "2") method = "CBE";
            else if (text.includes("transfer") || text === "3")
                method = "Transfer";
            else
                return ctx.reply(
                    "⚠️ Invalid method. Type Telebirr, CBE, or Transfer."
                );

            // Step 3: Create withdraw request
            const res = await createWithdrawRequestDynamic(
                user,
                session.data.amount,
                method
            );
            if (!res.ok) return ctx.reply(`❌ ${res.error}`);

            // notify admin
            try {
                await bot.telegram.sendMessage(
                    ADMIN_ID,
                    `📩 Withdraw Request\nID: ${res.request.id}\nUser: ${user.name} (${user.id})\nAmount: ${res.request.amount} ETB\nMethod: ${res.request.paymentMethod}\nUse /withdrawals to view requests.`
                );
            } catch (e) {
                console.error("Failed to notify admin:", e);
            }

            ctx.reply(
                `📩 Withdraw request submitted: ${res.request.amount} ETB via ${res.request.paymentMethod}. Admin will process it soon.`
            );
            delete userSessions[ctx.from.id]; // clear session
        }
    }
});

// /myid
bot.command("myid", ctx => {
    ctx.reply(`🆔 Your Telegram ID: ${ctx.from.id}`);
});

// ------------------ Admin Commands ------------------ //

// /users - list all users (admin)
bot.command("users", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    await db.read();
    const list = listUsersSummary();
    if (!list.length) return ctx.reply("No users yet.");
    let msg = `👥 Users (${list.length}):\n`;
    for (const u of list) {
        msg += `- ID: ${u.id} | ${u.name} | Package: ${
            u.package || "None"
        } | Balance: ${u.balance}\n`;
    }
    ctx.reply(msg);
});

// /user <id> - show full user details
bot.command("user", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) return ctx.reply("Usage: /user <userId>");
    const userId = Number(parts[1]);
    if (isNaN(userId)) return ctx.reply("❌ Invalid user ID");
    await db.read();
    const u = findUserById(userId);
    if (!u) return ctx.reply("❌ User not found.");
    const refs =
        db.data.users
            .filter(x => x.referredBy === u.referralCode)
            .map(r => `${r.name}(${r.id})`)
            .join(", ") || "None";
    ctx.reply(
        `📌 User: ${u.name}\nID: ${u.id}\nPackage: ${
            u.package || "None"
        }\nReferralCode: ${u.referralCode}\nReferredBy: ${
            u.referredBy || "None"
        }\nBalance: ${u.balance || 0}\nReferrals: ${refs}\nCreatedAt: ${
            u.createdAt || "N/A"
        }`
    );
});

// /add_pending <userId> <package> [note] - add pending purchase (admin)
bot.command("add_pending", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 3)
        return ctx.reply("Usage: /add_pending <userId> <package> [note]");
    const userId = parseInt(parts[1]);
    const packageType = parts[2];
    const note = parts.slice(3).join(" ") || "";
    await db.read();
    const res = await addPendingPurchase(userId, packageType, note);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);
    ctx.reply(
        `✅ Pending purchase added (id: ${res.entry.id}) for user ${userId}, package ${packageType}`
    );
});

// /pending - show pending purchases (admin)
bot.command("pending", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    await db.read();
    const p = db.data.pendingPurchases;
    if (!p.length) return ctx.reply("No pending purchases.");
    let msg = `⏳ Pending Purchases (${p.length}):\n`;
    for (const e of p) {
        msg += `- ID: ${e.id} | User: ${e.userId} | Package: ${
            e.package
        } | Note: ${e.note || "None"} | Created: ${e.createdAt}\n`;
    }
    ctx.reply(msg);
});

// /confirm <userId> <package> - confirm a purchase (admin)
bot.command("confirm", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 3)
        return ctx.reply("Usage: /confirm <userId> <package>");
    const userId = parseInt(parts[1]);
    const packageType = parts[2];
    await db.read();
    const res = await confirmPurchase(userId, packageType);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);
    ctx.reply(
        `✅ Purchase confirmed for user ${userId}, package: ${packageType}`
    );
});

// /confirm_purchase alias (admin)
bot.command("confirm_purchase", async ctx => {
    return bot.commands.get("confirm")
        ? bot.commands.get("confirm")(ctx)
        : ctx.reply("Use /confirm ...");
});

// /refs <userId> - show referrals of a user (admin)
bot.command("refs", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) return ctx.reply("Usage: /refs <userId>");
    const userId = parseInt(parts[1]);
    await db.read();
    const u = findUserById(userId);
    if (!u) return ctx.reply("User not found.");
    const refs = db.data.users.filter(x => x.referredBy === u.referralCode);
    if (!refs.length) return ctx.reply("This user has no referrals.");
    let msg = `👥 Referrals of ${u.name}:\n`;
    for (const r of refs)
        msg += `- ${r.name} (ID: ${r.id}) - ${r.package || "Pending"}\n`;
    ctx.reply(msg);
});

// /withdrawals - list withdraw requests (admin)
bot.command("withdrawals", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    await db.read();
    const w = db.data.withdraws;
    if (!w.length) return ctx.reply("No withdraw requests.");
    let msg = `📩 Withdraw Requests:\n`;
    for (const r of w) {
        msg += `- ID: ${r.id} | User: ${r.userId} | Amount: ${r.amount} | Status: ${r.status} | Created: ${r.createdAt}\n`;
    }
    ctx.reply(msg);
});

// /approve <withdrawId> [note] - approve a withdraw request (admin)
bot.command("approve", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2)
        return ctx.reply("Usage: /approve <withdrawId> [note]");
    const withdrawId = parts[1];
    const note = parts.slice(2).join(" ") || "";
    const res = await approveWithdrawRequest(withdrawId, note);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);
    ctx.reply(`✅ Withdraw ${withdrawId} approved.`);
});

// /reject <withdrawId> [reason] - reject a withdraw (admin)
bot.command("reject", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2)
        return ctx.reply("Usage: /reject <withdrawId> [reason]");
    const withdrawId = parts[1];
    const reason = parts.slice(2).join(" ") || "";
    const res = await rejectWithdrawRequest(withdrawId, reason);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);
    ctx.reply(
        `✅ Withdraw ${withdrawId} rejected and amount returned to user.`
    );
});

// /broadcast <message> - send message to all users (admin)
bot.command("broadcast", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) return ctx.reply("Usage: /broadcast <message>");
    const message = ctx.message.text.slice("/broadcast ".length);
    const res = await broadcastMessage(message);
    ctx.reply(`✅ Broadcast sent to ~${res.count} users.`);
});

// /stats - show basic stats (admin)
bot.command("stats", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    await db.read();
    const totalUsers = db.data.users.length;
    const totalWithdraws = db.data.withdraws
        .filter(w => w.status === "approved")
        .reduce((s, x) => s + (x.amount || 0), 0);
    const pendingPurchases = db.data.pendingPurchases.length;
    let msg = `📊 Stats:\n- Total users: ${totalUsers}\n- Pending purchases: ${pendingPurchases}\n- Total commissions paid (approx): ${
        totalWithdraws || 0
    } ETB\n`;
    ctx.reply(msg);
});

// /sales - show sales by package (admin)
bot.command("sales", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    await db.read();
    const counts = { Basic: 0, Premium: 0, VIP: 0 };
    for (const u of db.data.users) {
        if (u.package && counts[u.package] !== undefined) counts[u.package]++;
    }
    ctx.reply(
        `💼 Sales:\nBasic: ${counts.Basic}\nPremium: ${counts.Premium}\nVIP: ${counts.VIP}`
    );
});

// /setpackage <userId> <package> - admin set or change user's package (upgrade/downgrade)
bot.command("setpackage", async ctx => {
    if (!isAdmin(ctx)) return ctx.reply("❌ You are not admin.");
    const parts = ctx.message.text.split(" ");
    if (parts.length < 3)
        return ctx.reply("Usage: /setpackage <userId> <package>");
    const userId = parseInt(parts[1]);
    const packageType = parts[2];
    await db.read();
    const u = findUserById(userId);
    if (!u) return ctx.reply("User not found.");
    if (!PACKAGES[packageType]) return ctx.reply("Invalid package type.");
    u.package = packageType;
    await saveDB();
    ctx.reply(`✅ User ${userId} package set to ${packageType}`);
    // Optionally give commission when setting package? (we'll not auto-add commission here)
});

// === LAUNCH BOT ===
bot.launch();
console.log("🤖 Bot running with full admin & user features");

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
