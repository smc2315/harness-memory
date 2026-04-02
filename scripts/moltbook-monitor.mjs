#!/usr/bin/env node

/**
 * Moltbook monitor — checks for new comments, filters spam,
 * and logs meaningful interactions for review.
 *
 * Usage:
 *   node scripts/moltbook-monitor.mjs              # one-shot check
 *   node scripts/moltbook-monitor.mjs --watch 300   # poll every 5 min
 */

const API_KEY = process.env.MOLTBOOK_API_KEY || "moltbook_sk_7UMwh_LY0ubcMyMKNw6CrE3hIMTDnt7N";
const BASE = "https://www.moltbook.com/api/v1";
const SPAM_KEYWORDS = ["agentflex", "check where you stand", "climbing fastest"];

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return res.json();
}

async function checkHome() {
  const home = await api("/home");
  const account = home.your_account || {};
  const activity = home.activity_on_your_posts || [];

  console.log(`\n[${new Date().toLocaleTimeString()}] Karma: ${account.karma} | Unread: ${account.unread_notification_count}`);

  if (account.unread_notification_count === 0) {
    console.log("  No new notifications.");
    return [];
  }

  const meaningful = [];

  for (const post of activity) {
    if (post.new_notification_count === 0) continue;

    console.log(`\n  📝 [${post.submolt_name}] ${post.post_title}`);
    console.log(`     ${post.new_notification_count} new — by: ${(post.latest_commenters || []).join(", ")}`);

    // Fetch new comments
    const comments = await api(`/posts/${post.post_id}/comments?sort=new&limit=10`);

    for (const comment of comments.comments || []) {
      const isSpam = SPAM_KEYWORDS.some((kw) =>
        comment.content.toLowerCase().includes(kw.toLowerCase())
      );

      const label = isSpam ? "🚫 SPAM" : "💬 MEANINGFUL";
      console.log(`     ${label} @${comment.author?.name}: ${comment.content.substring(0, 120)}`);

      if (!isSpam) {
        meaningful.push({
          postId: post.post_id,
          postTitle: post.post_title,
          commentId: comment.id,
          author: comment.author?.name,
          content: comment.content,
          upvotes: comment.upvotes,
        });
      }

      // Check replies too
      for (const reply of comment.replies || []) {
        const replySpam = SPAM_KEYWORDS.some((kw) =>
          reply.content.toLowerCase().includes(kw.toLowerCase())
        );
        if (!replySpam && reply.author?.name !== "harness-memory") {
          console.log(`       └ 💬 @${reply.author?.name}: ${reply.content.substring(0, 100)}`);
          meaningful.push({
            postId: post.post_id,
            postTitle: post.post_title,
            commentId: reply.id,
            parentId: comment.id,
            author: reply.author?.name,
            content: reply.content,
            upvotes: reply.upvotes,
          });
        }
      }
    }
  }

  if (meaningful.length > 0) {
    console.log(`\n  ✅ ${meaningful.length} meaningful interaction(s) found.`);
  }

  return meaningful;
}

// Main
const watchInterval = process.argv.includes("--watch")
  ? parseInt(process.argv[process.argv.indexOf("--watch") + 1] || "300", 10)
  : 0;

if (watchInterval > 0) {
  console.log(`Monitoring Moltbook every ${watchInterval}s. Ctrl+C to stop.`);
  const run = async () => {
    try { await checkHome(); } catch (e) { console.error("Error:", e.message); }
  };
  await run();
  setInterval(run, watchInterval * 1000);
} else {
  const results = await checkHome();
  if (results.length > 0) {
    console.log("\nMeaningful comments to review:");
    for (const r of results) {
      console.log(`  @${r.author} on "${r.postTitle}":`);
      console.log(`    ${r.content.substring(0, 200)}`);
      console.log();
    }
  }
}
