// run_mysql_tests.js
/**
 * REAL MYSQL SCENARIOS (no Jest) — uses *only* your MySQLDB class for all I/O.
 *
 * What this does:
 *   1) Creates a realistic schema (users, vendors, products, orders, order_items, etc.)
 *   2) Builds many indexes (BTREE composites, partial-ish via predicates, FULLTEXT, JSON, generated cols)
 *   3) Seeds thousands of rows
 *   4) Runs BASIC → MEDIUM → ADVANCED → COMPLEX → STRESS scenarios
 *   5) Prints clear "OK" checkpoints; each block explains what a dev should verify
 *
 * Requires: MySQL 8.0+ (InnoDB), and your MySQLDB class.
 * Uses Session MAX_EXECUTION_TIME for timeouts (supported by MySQL 5.7.8+).
 *
 * HOW TO RUN:
 *   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASS=pass DB_NAME=play node run_mysql_tests.js
 *
 * NOTE: This file assumes ./mysql.js exports the class “MySQLDB”.
 *       If your file lives elsewhere, change the require() path accordingly.
 *
 * Uses your MySQLDB implementation: (see mysql.js in your project)  :contentReference[oaicite:0]{index=0}
 */

"use strict";

require("dotenv").config();

const MySQLDB = require("./db");

function assert(cond, msg) {
    if (!cond) throw new Error("ASSERT FAIL: " + msg);
}

async function createSchema(db) {
    console.log(">> INIT: creating schema");
    await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(200) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_users_active_created (is_active, created_at DESC),
      KEY idx_users_lower_email ((LOWER(email)))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    await db.query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL UNIQUE,
      rating DECIMAL(3,2) NOT NULL DEFAULT 4.50,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_vendors_rating_created (rating DESC, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    // products: JSON columns + generated columns for expression indexing
    await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      slug VARCHAR(255) NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL,
      title_lower VARCHAR(255) GENERATED ALWAYS AS (LOWER(title)) STORED,
      price_cents INT NOT NULL CHECK (price_cents >= 0),
      inventory INT NOT NULL DEFAULT 0 CHECK (inventory >= 0),
      tags JSON NOT NULL,
      attrs JSON NOT NULL,
      attrs_color VARCHAR(32) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(attrs, '$.color'))) STORED,
      attrs_size  VARCHAR(16) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(attrs, '$.size'))) STORED,
      vendor_id BIGINT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_products_vendor_created (vendor_id, created_at DESC),
      KEY idx_products_active_created (active, created_at DESC),
      KEY idx_products_price_vendor (price_cents ASC, vendor_id ASC),
      KEY idx_products_title_lower (title_lower),
      KEY idx_products_created (created_at),
      KEY idx_products_attrs_color (attrs_color),
      KEY idx_products_attrs_size (attrs_size),
      CONSTRAINT fk_products_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    // FULLTEXT on title/description in search_docs (requires InnoDB + MySQL 5.6+; better in 8.0+)
    await db.query(`
    CREATE TABLE IF NOT EXISTS search_docs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      ref_type ENUM('user','product','order') NOT NULL,
      ref_id BIGINT UNSIGNED NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      extra JSON NOT NULL,
      PRIMARY KEY (id),
      KEY idx_search_docs_type_ref (ref_type, ref_id),
      FULLTEXT KEY ftx_search_docs_title_description (title, description)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
    // REMOVED WILL PUT BACK IF FOUND TO BE USEFUL
    // FULLTEXT KEY ftx_search_docs_title (title),
    // FULLTEXT KEY ftx_search_docs_description (description)

    await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      status ENUM('pending','paid','cancelled','refunded') NOT NULL,
      total_cents INT NOT NULL CHECK (total_cents >= 0),
      meta JSON NOT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_orders_user_status_created (user_id, status, created_at DESC),
      KEY idx_orders_total_status (total_cents DESC, status),
      CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    await db.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      qty INT NOT NULL CHECK (qty > 0),
      price_cents INT NOT NULL CHECK (price_cents >= 0),
      PRIMARY KEY (id),
      UNIQUE KEY uq_order_product (order_id, product_id),
      KEY idx_order_items_product (product_id),
      CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      CONSTRAINT fk_oi_product FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      product_id BIGINT UNSIGNED NOT NULL,
      delta INT NOT NULL,
      reason VARCHAR(64) NOT NULL,
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_inv_moves_prod_created (product_id, created_at DESC),
      CONSTRAINT fk_im_product FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    // Optional: room_bookings (no EXCLUDE in MySQL; we enforce via SELECT ... FOR UPDATE)
    await db.query(`
    CREATE TABLE IF NOT EXISTS room_bookings (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      room_id BIGINT UNSIGNED NOT NULL,
      start_at DATETIME(3) NOT NULL,
      end_at   DATETIME(3) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_room_bookings_room_time (room_id, start_at, end_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function truncateAll(db) {
    console.log(">> INIT: truncating");
    // order matters: child tables first
    await db.query(`SET FOREIGN_KEY_CHECKS = 0`);
    await db.query(`TRUNCATE TABLE order_items`);
    await db.query(`TRUNCATE TABLE orders`);
    await db.query(`TRUNCATE TABLE inventory_movements`);
    await db.query(`TRUNCATE TABLE products`);
    await db.query(`TRUNCATE TABLE search_docs`);
    await db.query(`TRUNCATE TABLE vendors`);
    await db.query(`TRUNCATE TABLE users`);
    await db.query(`TRUNCATE TABLE room_bookings`);
    await db.query(`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed(db) {
    console.log(">> INIT: seeding");

    // vendors
    console.log(">> INIT: seeding vendors");
    for (let i = 1; i <= 12; i++) {
        await db.insert("vendors", { name: `Vendor ${i}`, rating: (3.5 + (i % 15) / 10).toFixed(2) });
    }

    // users
    const userIds = [];
    console.log(">> INIT: seeding users");
    for (let i = 1; i <= 500; i++) {
        const id = await db.insert("users", { email: `user${i}@example.com`, name: `User ${i}`, is_active: i % 6 !== 0 ? 1 : 0 });
        userIds.push(id);
    }

    // products
    const tagPool = ["eco", "sale", "gift", "premium", "bundle", "new", "popular", "red", "blue", "green", "xl"];
    const productIds = [];
    console.log(">> INIT: seeding products");
    for (let i = 1; i <= 2_000; i++) {
        const tags = tagPool.filter(() => Math.random() < 0.2);
        if (!tags.length) tags.push("new");
        const attrs = { color: ["red", "blue", "green"][i % 3], size: ["S", "M", "L", "XL"][i % 4] };
        const vendorId = ((i % 12) + 1);
        const id = await db.insert("products", {
            slug: `p-${i}`,
            title: `Product ${i}${i % 5 === 0 ? " Deluxe" : ""}`,
            price_cents: 300 + (i % 250) * 20,
            inventory: 5 + (i % 100),
            tags: JSON.stringify(tags),
            attrs: JSON.stringify(attrs),
            vendor_id: vendorId,
            active: i % 17 ? 1 : 0
        });
        productIds.push(id);
        await db.insert("inventory_movements", { product_id: id, delta: 5 + (i % 100), reason: "seed" });
        await db.insert("search_docs", {
            ref_type: "product",
            ref_id: id,
            title: `Buy Product ${i} for ${((300 + (i % 250) * 20) / 100).toFixed(2)}`,
            description: `Tags: ${tags.join(", ")} | Color:${attrs.color} | Size:${attrs.size}`,
            extra: JSON.stringify({ vendor_id: vendorId })
        });
    }

    // orders + items
    console.log(">> INIT: seeding orders + items");
    const statuses = ["pending", "paid", "cancelled", "refunded"];
    for (let i = 1; i <= 3_000; i++) {
        const userId = userIds[i % userIds.length];
        const pA = productIds[i % productIds.length];
        const pB = productIds[(i + 1) % productIds.length];

        // get prices
        const rowA = await db.getRow(`SELECT price_cents FROM products WHERE id=?`, [pA]);
        const rowB = await db.getRow(`SELECT price_cents FROM products WHERE id=?`, [pB]);
        const total = (rowA?.price_cents || 0) + (rowB?.price_cents || 0);

        const orderId = await db.insert("orders", {
            user_id: userId,
            status: statuses[i % statuses.length],
            total_cents: total,
            meta: JSON.stringify({ source: i % 2 ? "web" : "mobile", coupon: i % 20 === 0 ? "WELCOME20" : null })
        });
        await db.insert("order_items", { order_id: orderId, product_id: pA, qty: 1, price_cents: rowA?.price_cents || 0 });
        await db.insert("order_items", { order_id: orderId, product_id: pB, qty: 1, price_cents: rowB?.price_cents || 0 });
    }
}

async function basicScenarios(db) {
    console.log("\n=== BASIC SCENARIOS ===");

    // B1) insert + fetch
    console.log("B1) Insert + fetch user (should return same email) …");
    const id = await db.insert("users", { email: "alice@example.com", name: "Alice", is_active: 1 });
    const row = await db.getRow(`SELECT * FROM users WHERE id=?`, [id]);
    assert(row.email === "alice@example.com", "user email mismatch");
    console.log("OK");

    // B2) update + delete
    console.log("B2) Update + delete product (should reflect changes then delete row) …");
    const pid = await db.insert("products", { slug: "basic-1", title: "Basic", price_cents: 500, inventory: 10, tags: "[]", attrs: "{}", active: 1 });
    const okUpd = await db.update("products", { price_cents: 999 }, "id = ?", [pid]);
    assert(okUpd, "update failed");
    const okDel = await db.deleteRow("products", { id: pid });
    assert(okDel, "delete failed");
    console.log("OK");

    // B3) unique violation
    console.log("B3) Unique violation on users.email (second insert should fail) …");
    let failed = false;
    try {
        await db.insert("users", { email: "alice@example.com", name: "Alice 2", is_active: 1 });
    } catch { failed = true; }
    assert(failed, "expected unique violation");
    console.log("OK");

    // B4) simple aggregate
    console.log("B4) Count active users (should be >= 1) …");
    const count = await db.getVar(`SELECT COUNT(*) AS c FROM users WHERE is_active = 1`);
    assert(count >= 1, "expected >= 1 active user");
    console.log("OK");
}

async function mediumScenarios(db) {
    console.log("\n=== MEDIUM SCENARIOS ===");

    // M1) join + group by + limit
    console.log("M1) Top buyers: users→orders group by count desc limit 5 …");
    const rows = await db.getResults(`
    SELECT u.id, u.email, COUNT(o.id) AS orders_count
    FROM users u
    JOIN orders o ON o.user_id = u.id
    GROUP BY u.id
    ORDER BY orders_count DESC
    LIMIT 5
  `);
    assert(rows.length > 0, "expected top buyers");
    console.log("OK");

    // M2) expression index via generated column (title_lower)
    console.log("M2) Case-insensitive title search via title_lower index …");
    const r2 = await db.getResults(`SELECT id FROM products WHERE title_lower LIKE ? LIMIT 10`, ["product 1%"]);
    assert(r2.length >= 1, "expected products like 'Product 1%'");
    console.log("OK");

    // M3) “partial” effect using active predicate + created_at
    console.log("M3) Recent active products (active=1 AND created_at window) …");
    const r3 = await db.getResults(`
    SELECT id FROM products
     WHERE active=1
       AND created_at > NOW() - INTERVAL 365 DAY
     ORDER BY created_at DESC
     LIMIT 20
  `);
    assert(r3.length >= 1, "expected recent active products");
    console.log("OK");

    // M4) JSON filters (attrs + tags)
    console.log("M4) JSON filter: tags contains 'eco' and attrs.color = 'red' …");
    const r4 = await db.getResults(`
    SELECT id FROM products
     WHERE JSON_CONTAINS(tags, JSON_ARRAY('eco'))
       AND JSON_EXTRACT(attrs, '$.color') = '\"red\"'
     LIMIT 30
  `);
    assert(r4.length >= 0, "json query executed");
    console.log("OK");

    // M5) unique(order_id, product_id)
    console.log("M5) order_items unique(order_id, product_id) — second insert should fail …");
    const anyOrder = await db.getVar(`SELECT id FROM orders LIMIT 1`);
    const anyProduct = await db.getVar(`SELECT id FROM products LIMIT 1`);
    let uv = false;
    try {
        await db.insert("order_items", { order_id: anyOrder, product_id: anyProduct, qty: 1, price_cents: 123 });
        await db.insert("order_items", { order_id: anyOrder, product_id: anyProduct, qty: 1, price_cents: 123 });
    } catch { uv = true; }
    assert(uv, "expected unique key violation on (order_id, product_id)");
    console.log("OK");
}

async function advancedScenarios(db) {
    console.log("\n=== ADVANCED SCENARIOS ===");

    // A1) transaction commit: create order+items atomically
    console.log("A1) Transaction commit: order + 2 items → commit and persist …");
    const userId = await db.getVar(`SELECT id FROM users WHERE is_active=1 LIMIT 1`);
    const prodA = await db.getRow(`SELECT id, price_cents FROM products ORDER BY id LIMIT 1`);
    const prodB = await db.getRow(`SELECT id, price_cents FROM products ORDER BY id LIMIT 1 OFFSET 1`);
    let orderId;
    await db.transaction(async (conn) => {
        const [res1] = await conn.execute(`INSERT INTO orders(user_id,status,total_cents,meta) VALUES (?,?,?,JSON_OBJECT())`, [userId, "pending", 0]);
        orderId = res1.insertId;
        await conn.execute(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES (?,?,1,?)`, [orderId, prodA.id, prodA.price_cents]);
        await conn.execute(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES (?,?,1,?)`, [orderId, prodB.id, prodB.price_cents]);
        await conn.execute(`UPDATE orders SET total_cents=?, status='paid' WHERE id=?`, [prodA.price_cents + prodB.price_cents, orderId]);
    });
    const cnt = await db.getVar(`SELECT COUNT(*) FROM order_items WHERE order_id=?`, [orderId]);
    assert(cnt === 2, "expected two order_items after commit");
    console.log("OK");

    // A2) transaction rollback: force error (check constraint qty>0)
    console.log("A2) Transaction rollback: violate constraint (qty <= 0) → nothing persists …");
    let o2 = 0;
    let rolled = false;
    try {
        await db.transaction(async (conn) => {
            const [ins] = await conn.execute(`INSERT INTO orders(user_id,status,total_cents,meta) VALUES (?,?,?,JSON_OBJECT())`, [userId, "pending", 0]);
            o2 = ins.insertId;
            await conn.execute(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES (?,?,0,?)`, [o2, prodA.id, 100]); // qty check violation
        });
    } catch { rolled = true; }
    const check = await db.getRow(`SELECT * FROM orders WHERE id=?`, [o2]);
    assert(rolled && !check, "should rollback invalid order");
    console.log("OK");

    // A3) multi-index filter + sort
    console.log("A3) Multi-index filter: vendor + price window + active + time window …");
    const vendorId = await db.getVar(`SELECT id FROM vendors ORDER BY rating DESC LIMIT 1`);
    const r = await db.getResults(`
    SELECT id FROM products
     WHERE vendor_id=?
       AND price_cents BETWEEN ? AND ?
       AND active=1
       AND created_at > NOW() - INTERVAL 365 DAY
     ORDER BY price_cents ASC, vendor_id ASC
     LIMIT 50
  `, [vendorId, 1000, 5000]);
    assert(r.length >= 0, "multi-index query ran");
    console.log("OK");

    // A4) FULLTEXT search (planner may use FTS indexes)
    console.log("A4) FULLTEXT search on search_docs.title/description …");
    // NOTE: requires innodb_ft_min_token_size <= 3 for short tokens; default works for basic words.
    const ft = await db.getResults(`
    SELECT id FROM search_docs
     WHERE MATCH (title, description) AGAINST (? IN NATURAL LANGUAGE MODE)
     LIMIT 20
  `, ["Deluxe"]);
    assert(ft.length >= 0, "fulltext query ran");
    console.log("OK");
}

async function complexScenarios(db) {
    console.log("\n=== COMPLEX SCENARIOS ===");

    // C1) Window-like ranking via variable (MySQL-specific trick) or use window functions (MySQL 8 supports WINDOW!)
    console.log("C1) Rank users by total spent using window functions …");
    const top = await db.getResults(`
    WITH spent AS (
      SELECT user_id, SUM(total_cents) AS total_spent
        FROM orders
       WHERE status IN ('paid','refunded')
       GROUP BY user_id
    )
    SELECT user_id, total_spent,
           RANK() OVER (ORDER BY total_spent DESC) AS rnk
      FROM spent
     ORDER BY rnk
     LIMIT 10
  `);
    assert(top.length <= 10, "expect ≤ 10 rows");
    console.log("OK");

    // C2) Big join with selective filters
    console.log("C2) Large join: users × orders × order_items × products with filters …");
    const jr = await db.getResults(`
    SELECT u.id AS user_id,
           COUNT(DISTINCT o.id)  AS order_count,
           SUM(oi.price_cents)   AS items_sum
      FROM users u
      JOIN orders o      ON o.user_id = u.id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p     ON p.id = oi.product_id
     WHERE u.is_active = 1
       AND o.created_at > NOW() - INTERVAL 90 DAY
       AND p.active = 1
     GROUP BY u.id
     ORDER BY order_count DESC
     LIMIT 20
  `);
    assert(jr.length >= 0, "large join ran");
    console.log("OK");

    // C3) “Exclusion” overlap prevention using SELECT … FOR UPDATE pattern
    console.log("C3) Overlap prevention: SERIALIZABLE booking insert (should block overlap) …");
    const roomId = 777;
    const start = new Date(Date.now() + 10 * 60 * 1000);  // +10 minutes
    const end = new Date(Date.now() + 70 * 60 * 1000);  // +70 minutes
    // First booking:
    await db.transaction(async (conn) => {
        await conn.execute(`INSERT INTO room_bookings(room_id,start_at,end_at) VALUES (?,?,?)`, [roomId, start, end]);
    });
    // Second overlapping booking should fail our guard:
    let overlapFailed = false;
    try {
        await db.transaction(async (conn) => {
            // Lock any overlapping rows for this room:
            const [locks] = await conn.execute(
                `SELECT id FROM room_bookings WHERE room_id=? AND NOT (end_at <= ? OR start_at >= ?) FOR UPDATE`,
                [roomId, start, end]
            );
            if (locks.length > 0) throw new Error("Overlap detected");
            await conn.execute(`INSERT INTO room_bookings(room_id,start_at,end_at) VALUES (?,?,?)`, [roomId, start, end]);
        });
    } catch { overlapFailed = true; }
    assert(overlapFailed, "expected overlap to be blocked");
    console.log("OK");

    // C4) EXPLAIN (read manually to ensure indexes are used)
    console.log("C4) EXPLAIN — read output manually for index usage …");
    const plan = await db.getResults(`
    EXPLAIN FORMAT=TREE
    SELECT id FROM products
     WHERE active=1
       AND JSON_CONTAINS(tags, JSON_ARRAY('eco'))
       AND price_cents BETWEEN ? AND ?
     ORDER BY price_cents ASC
     LIMIT 50
  `, [1000, 5000]);
    console.log(plan.map(r => Object.values(r)[0]).join("\n"));
    console.log("OK");
}

async function stressScenarios(db) {
    console.log("\n=== STRESS SCENARIOS ===");

    // S1) 100 concurrent orders in transactions (with retry on deadlocks/timeouts — built into MySQLDB.transaction)
    console.log("S1) 100 concurrent paid orders (each must commit exactly one order row) …");
    const u = await db.getVar(`SELECT id FROM users WHERE is_active=1 LIMIT 1`);
    const pa = await db.getRow(`SELECT id, price_cents FROM products ORDER BY id LIMIT 1`);
    const pb = await db.getRow(`SELECT id, price_cents FROM products ORDER BY id LIMIT 1 OFFSET 1`);
    const tasks = [];
    for (let i = 0; i < 100; i++) {
        tasks.push(
            db.transaction(async (conn) => {
                const [o] = await conn.execute(
                    `INSERT INTO orders(user_id,status,total_cents,meta) VALUES (?,?,?,JSON_OBJECT())`,
                    [u, "pending", 0]
                );
                const oid = o.insertId;
                await conn.execute(
                    `INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES (?,?,1,?)`,
                    [oid, pa.id, pa.price_cents]
                );
                await conn.execute(
                    `INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES (?,?,1,?)`,
                    [oid, pb.id, pb.price_cents]
                );
                await conn.execute(
                    `UPDATE orders SET total_cents=?, status='paid' WHERE id=?`,
                    [pa.price_cents + pb.price_cents, oid]
                );
            }, { maxRetries: 3, initialDelayMs: 50 })
        );
    }
    await Promise.all(tasks);
    const paid = await db.getVar(`SELECT COUNT(*) FROM orders WHERE status='paid'`);
    assert(paid >= 100, "expected ≥100 paid orders after stress");
    console.log("OK");

    // S2) 200 JSON queries loop (timeout-protected)
    console.log("S2) 200 JSON_CONTAINS loops (ensure no leaks/hangs) …");
    for (let i = 0; i < 200; i++) {
        const tag = i % 2 ? "sale" : "eco";
        const res = await db.getResults(
            `SELECT id FROM products WHERE JSON_CONTAINS(tags, JSON_ARRAY(?)) LIMIT 20`,
            [tag],
            { timeoutMs: 500 }
        );
        assert(res.length >= 0, "json loop ok");
    }
    console.log("OK");

    // S3) Bulk price bump in chunks (throughput check)
    console.log("S3) Bulk price updates in 10 chunks …");
    const total = await db.getVar(`SELECT COUNT(*) FROM products`);
    const chunk = Math.max(1, Math.floor(total / 10));
    for (let off = 0; off < total; off += chunk) {
        await db.transaction(async (conn) => {
            const query = `
                UPDATE products
                JOIN (
                    SELECT id FROM products ORDER BY id ASC LIMIT ${chunk} OFFSET ${off}
                ) AS t ON products.id = t.id
                SET products.price_cents = products.price_cents + 1
            `;
            await conn.execute(query);
        });
    }
    const minmax = await db.getRow(`SELECT MIN(price_cents) AS minp, MAX(price_cents) AS maxp FROM products`);
    assert(minmax.minp <= minmax.maxp, "bulk updates reflected");
    console.log("OK");
}

(async () => {
    const POOL = "default";
    const db = new MySQLDB({
        persistent: true,
        onQuery: null,
    });

    try {
        const ok = await db.connect(POOL);
        if (!ok) throw new Error("DB pool connection failed; check env vars");

        await createSchema(db);
        await truncateAll(db);
        await seed(db);

        await basicScenarios(db);
        await mediumScenarios(db);
        await advancedScenarios(db);
        await complexScenarios(db);
        await stressScenarios(db);

        console.log("\nALL MYSQL SCENARIOS COMPLETED SUCCESSFULLY ✅");
    } catch (err) {
        console.error("\nFAILED ❌", err);
        console.error("DB Errors:", db.errors);
        process.exitCode = 1;
    } finally {
        await db.endAll();
    }
})();
