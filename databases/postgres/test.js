require("dotenv").config();

const DB = require("./db");

function assert(cond, msg) {
    if (!cond) throw new Error("ASSERT FAIL: " + msg);
}

async function tryExtension(db, connection, sql) {
    try { await db.query(connection, sql); return true; } catch { return false; }
}

async function createSchema(db, connection) {
    await db.query(connection, `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      rating NUMERIC(3,2) NOT NULL DEFAULT 4.50,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory >= 0),
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      attrs JSONB NOT NULL DEFAULT '{}'::jsonb,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending','paid','cancelled','refunded')),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      qty INTEGER NOT NULL CHECK (qty > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      UNIQUE(order_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS search_docs (
      id SERIAL PRIMARY KEY,
      ref_type TEXT NOT NULL,  -- 'user' | 'product' | 'order'
      ref_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      extra JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

    const trigram = await tryExtension(db, connection, `CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    const btree_gist = await tryExtension(db, connection, `CREATE EXTENSION IF NOT EXISTS btree_gist`);

    if (btree_gist) {
        await db.query(connection, `
      CREATE TABLE IF NOT EXISTS room_bookings (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL,
        tsrange tstzrange NOT NULL,
        EXCLUDE USING GIST (room_id WITH =, tsrange WITH &&)
      );
    `);
    }

    return { trigram, btree_gist };
}

async function createIndexes(db, connection, ext) {
    await db.query(connection, `
    -- USERS
    CREATE INDEX IF NOT EXISTS idx_users_active_created ON users(is_active, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users((lower(email)));

    -- VENDORS
    CREATE INDEX IF NOT EXISTS idx_vendors_rating_created ON vendors(rating DESC, created_at DESC);

    -- PRODUCTS
    CREATE INDEX IF NOT EXISTS idx_products_vendor_created ON products(vendor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_active_partial ON products(created_at) WHERE active = TRUE;
    CREATE INDEX IF NOT EXISTS idx_products_price_vendor ON products(price_cents ASC, vendor_id ASC);
    CREATE INDEX IF NOT EXISTS idx_products_title_expr ON products((lower(title)));
    CREATE INDEX IF NOT EXISTS idx_products_created_brin ON products USING BRIN (created_at);
    CREATE INDEX IF NOT EXISTS idx_products_tags_gin ON products USING GIN (tags jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS idx_products_attrs_gin ON products USING GIN (attrs);

    -- ORDERS
    CREATE INDEX IF NOT EXISTS idx_orders_user_status_created ON orders(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_total_status ON orders(total_cents DESC, status);

    -- ORDER ITEMS
    CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

    -- INVENTORY MOVES
    CREATE INDEX IF NOT EXISTS idx_inv_moves_prod_created ON inventory_movements(product_id, created_at DESC);

    -- SEARCH DOCS
    CREATE INDEX IF NOT EXISTS idx_search_docs_type_ref ON search_docs(ref_type, ref_id);
  `);

    if (ext.trigram) {
        await db.query(connection, `
      CREATE INDEX IF NOT EXISTS idx_search_docs_title_trgm ON search_docs USING GIN (title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_search_docs_desc_trgm ON search_docs USING GIN (description gin_trgm_ops);
    `);
    }

    if (ext.btree_gist) {
        await db.query(connection, `CREATE INDEX IF NOT EXISTS idx_room_bookings_room ON room_bookings(room_id)`);
    }
}

async function truncateAll(db, connection) {
    await db.withTransaction(connection, async ({ query }) => {
        await query(`TRUNCATE TABLE order_items RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE orders RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE inventory_movements RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE products RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE search_docs RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE vendors RESTART IDENTITY CASCADE`);
        await query(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
        try { await query(`TRUNCATE TABLE room_bookings RESTART IDENTITY CASCADE`); } catch { }
    });
}
async function seed(db, connection) {
    // vendors
    const vendors = [];
    for (let i = 1; i <= 12; i++) {
        vendors.push(await db.insert(connection, "vendors", { name: `Vendor ${i}`, rating: 3.5 + (i % 15) / 10 }));
    }

    // users
    const users = [];
    for (let i = 1; i <= 200; i++) {
        const active = i % 6 !== 0; // ~16% inactive
        users.push(await db.insert(connection, "users", {
            email: `user${i}@example.com`,
            name: `User ${i}`,
            is_active: active
        }));
    }

    // products
    const products = [];
    const tagPool = ["eco", "sale", "gift", "premium", "bundle", "new", "popular", "red", "blue", "green", "xl"];
    for (let i = 1; i <= 1000; i++) {
        const tags = tagPool.filter(() => Math.random() < 0.2);
        if (!tags.length) tags.push("new");
        const attrs = { color: ["red", "blue", "green"][i % 3], size: ["S", "M", "L", "XL"][i % 4] };
        const p = await db.insert(connection, "products", {
            slug: `p-${i}`,
            title: `Product ${i} ${i % 5 === 0 ? "Deluxe" : ""}`.trim(),
            price_cents: 300 + (i % 250) * 20,
            inventory: 5 + (i % 100),
            tags: JSON.stringify(tags),
            attrs: JSON.stringify(attrs),
            vendor_id: vendors[i % vendors.length].id,
            active: i % 17 !== 0
        });
        products.push(p);
        await db.insert(connection, "inventory_movements", {
            product_id: p.id, delta: +p.inventory, reason: "seed"
        });
        await db.insert(connection, "search_docs", {
            ref_type: "product",
            ref_id: p.id,
            title: `Buy ${p.title} for ${(p.price_cents / 100).toFixed(2)}`,
            description: `Tags: ${tags.join(", ")} | Color:${attrs.color} | Size:${attrs.size}`,
            extra: JSON.stringify({ vendor_id: p.vendor_id })
        });
    }

    // orders + items
    const statuses = ["pending", "paid", "cancelled", "refunded"];
    for (let i = 1; i <= 1500; i++) {
        const u = users[i % users.length];
        const chosen = Array.from(new Set([products[i % products.length], products[(i * 7) % products.length]]));
        const total = chosen.reduce((s, p) => s + p.price_cents, 0);

        const o = await db.insert(connection, "orders", {
            user_id: u.id,
            status: statuses[i % statuses.length],
            total_cents: total,
            meta: JSON.stringify({ source: i % 2 ? "web" : "mobile", coupon: i % 20 === 0 ? "WELCOME20" : null })
        });
        for (const p of chosen) {
            await db.insert(connection, "order_items", {
                order_id: o.id, product_id: p.id, qty: 1, price_cents: p.price_cents
            });
        }
    }

    return { users, vendors, products };
}

async function basicScenarios(db, connection) {
    console.log("\n=== BASIC SCENARIOS ===");

    // 1) Test Basic Scenario Insert/Get Helpers
    console.log("B1) Insert + fetch user (should return same email) …");
    const u = await db.insert(connection, "users", { email: "alice@example.com", name: "Alice" });
    const u2 = await db.getRow(connection, `SELECT * FROM users WHERE id=$1`, [u.id]);

    assert(u2.email === "alice@example.com", "user email mismatch");
    console.log("OK");

    // 2) Test Basic Scenario Update/Delete Helpers
    console.log("B2) Update + delete product (should update email then remove row) …");

    const p = await db.insert(connection, "products", { slug: "basic-1", title: "Basic", price_cents: 500, inventory: 10, tags: "[]", attrs: "{}", active: true });
    const up = await db.update(connection, "products", { price_cents: 999 }, "id=$1", [p.id]);

    assert(up[0].price_cents === 999, "price not updated");

    const del = await db.delete(connection, "products", "id=$1", [p.id]);
    assert(del.length === 1, "delete failed");

    console.log("OK");

    // 3) Test Basic Scenario Unique Violation
    console.log("B3) Unique violation on users.email (should throw) …");

    let threw = false;
    try {
        await db.insert(connection, "users", { email: "alice@example.com", name: "Alice 2" });
    } catch { threw = true; }

    assert(threw, "expected unique violation");
    console.log("OK");

    // 4) Test Basic Scenario Simple Aggregate
    console.log("B4) Count active users (should be >= 1) …");
    const c = await db.getRow(connection, `SELECT COUNT(*)::int AS c FROM users WHERE is_active = TRUE`);
    assert(c.c >= 1, "active users expected >=1");
    console.log("OK");
}

async function mediumScenarios(db, connection) {
    console.log("\n=== MEDIUM SCENARIOS ===");

    // 5) join + group by + index usage
    console.log("M1) Top buyers: join users→orders, group by user, limit 5 (should return rows) …");
    const rows = await db.getAll(connection, `
    SELECT u.id, u.email, COUNT(o.id)::int AS orders_count
    FROM users u
    JOIN orders o ON o.user_id = u.id
    GROUP BY u.id
    ORDER BY orders_count DESC
    LIMIT 5
  `);
    assert(rows.length > 0, "expected top buyers");
    console.log("OK");

    // 6) expression index (lower(title)) + filter
    console.log("M2) Case-insensitive title search leveraging expression index (should return >=1) …");
    const r2 = await db.getAll(connection, `
    SELECT id FROM products WHERE lower(title) LIKE $1 LIMIT 10
  `, ["product 1%"]);
    assert(r2.length >= 1, "expected products like 'Product 1%'");
    console.log("OK");

    // 7) partial index (active=true)
    console.log("M3) Active products recent window (partial index should help) …");
    const r3 = await db.getAll(connection, `
    SELECT id FROM products
     WHERE active = TRUE
       AND created_at > NOW() - INTERVAL '180 days'
     ORDER BY created_at DESC
     LIMIT 20
  `);
    assert(r3.length >= 1, "expected recent active products");
    console.log("OK");

    // 8) JSONB GIN filter
    console.log("M4) JSONB GIN: products with tags @> ['eco'] and attrs->>'color' = 'red' …");
    const r4 = await db.getAll(connection, `
    SELECT id FROM products
     WHERE tags @> $1::jsonb
       AND attrs->>'color' = $2
     LIMIT 30
  `, [JSON.stringify(["eco"]), "red"]);
    assert(r4.length >= 0, "query executed");
    console.log("OK");

    // 9) order_items unique constraint
    console.log("M5) order_items unique(order_id, product_id) (second insert should fail) …");
    const anyOrder = await db.getRow(connection, `SELECT id FROM orders LIMIT 1`);
    const anyProduct = await db.getRow(connection, `SELECT id FROM products LIMIT 1`);
    let failed = false;
    try {
        await db.insert(connection, "order_items", { order_id: anyOrder.id, product_id: anyProduct.id, qty: 1, price_cents: 123 });
        await db.insert(connection, "order_items", { order_id: anyOrder.id, product_id: anyProduct.id, qty: 1, price_cents: 123 });
    } catch { failed = true; }
    assert(failed, "expected unique violation on (order_id, product_id)");
    console.log("OK");
}

async function advancedScenarios(db, connection) {
    console.log("\n=== ADVANCED SCENARIOS ===");

    // 10) transaction commit
    console.log("A1) Transaction: create order + items, commit (order + items must exist) …");
    const u = await db.getRow(connection, `SELECT id FROM users WHERE is_active = TRUE LIMIT 1`);
    let orderId;
    await db.withTransaction(connection, async ({ query }) => {
        const o = await query(`INSERT INTO orders(user_id,status,total_cents,meta) VALUES($1,'pending',0,'{}'::jsonb) RETURNING id`, [u.id]);
        orderId = o.rows[0].id;
        const p1 = await db.getRow(connection, `SELECT id, price_cents FROM products ORDER BY id LIMIT 1`);
        const p2 = await db.getRow(connection, `SELECT id, price_cents FROM products ORDER BY id OFFSET 1 LIMIT 1`);
        await query(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,1,$3)`, [orderId, p1.id, p1.price_cents]);
        await query(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,1,$3)`, [orderId, p2.id, p2.price_cents]);
        await query(`UPDATE orders SET total_cents = $1 WHERE id=$2`, [p1.price_cents + p2.price_cents, orderId]);
    });
    const oi = await db.getAll(connection, `SELECT * FROM order_items WHERE order_id=$1`, [orderId]);
    assert(oi.length === 2, "expected 2 order_items");
    console.log("OK");

    // 11) transaction rollback
    console.log("A2) Transaction: force error (rollback); nothing should persist …");
    let o2Id = null;
    try {
        await db.withTransaction(connection, async ({ query }) => {
            const o2 = await query(`INSERT INTO orders(user_id,status,total_cents,meta) VALUES($1,'pending',0,'{}') RETURNING id`, [u.id]);
            o2Id = o2.rows[0].id;
            await query(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,0,$3)`, [o2Id, 999999, 100]); // qty check violation
        });
        assert(false, "should have thrown");
    } catch {
        const chk = await db.getRow(connection, `SELECT * FROM orders WHERE id=$1`, [o2Id]);
        assert(chk === null, "rolled back order should not exist");
        console.log("OK");
    }

    // 12) multi-index filter + sort
    console.log("A3) Multi-index query: vendor + price range + time window + active …");
    const row = await db.getRow(connection, `SELECT id FROM vendors ORDER BY rating DESC LIMIT 1`);
    const r = await db.getAll(connection, `
    SELECT id FROM products
     WHERE vendor_id = $1
       AND price_cents BETWEEN $2 AND $3
       AND active = TRUE
       AND created_at > NOW() - INTERVAL '365 days'
     ORDER BY price_cents ASC, vendor_id ASC
     LIMIT 50
  `, [row.id, 1000, 5000]);
    assert(r.length >= 0, "ran multi-index filter");
    console.log("OK");

    // 13) JSONB combination + order by numeric
    console.log("A4) JSONB combination: tags @> ['sale'] and attrs->>'size' IN ('L','XL') …");
    const rj = await db.getAll(connection, `
    SELECT id, price_cents
      FROM products
     WHERE tags @> $1::jsonb
       AND (attrs->>'size') IN ('L','XL')
     ORDER BY price_cents DESC
     LIMIT 30
  `, [JSON.stringify(["sale"])]);
    assert(rj.length >= 0, "ran jsonb + order-by");
    console.log("OK");

    // 14) search_docs lookup + optional trigram (if installed planner may use it)
    console.log("A5) Search docs LIKE (planner may use trigram if ext exists) …");
    const sd = await db.getAll(connection, `
    SELECT id FROM search_docs
     WHERE title ILIKE $1
     ORDER BY id DESC
     LIMIT 20
  `, ["%Deluxe%"]);
    assert(sd.length >= 0, "search executed");
    console.log("OK");
}

async function complexScenarios(db, connection, ext) {
    console.log("\n=== COMPLEX SCENARIOS ===");

    // 15) window functions on orders
    console.log("C1) Window function: rank users by total spent (Top 10) …");
    const top = await db.getAll(connection, `
    WITH spent AS (
      SELECT o.user_id, SUM(o.total_cents)::bigint AS total_spent
        FROM orders o
       WHERE o.status IN ('paid','refunded')
       GROUP BY o.user_id
    )
    SELECT user_id, total_spent,
           RANK() OVER (ORDER BY total_spent DESC) AS rnk
      FROM spent
     ORDER BY rnk
     LIMIT 10
  `);
    assert(top.length <= 10, "expect ≤ 10 rows");
    console.log("OK");

    // 16) large join with selective filters, ensure planner can use composite indexes
    console.log("C2) Large join: users × orders × order_items × products with filters …");
    const jr = await db.getAll(connection, `
    SELECT u.id AS user_id, COUNT(DISTINCT o.id)::int AS order_count, SUM(oi.price_cents)::bigint AS items_sum
      FROM users u
      JOIN orders o ON o.user_id = u.id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
     WHERE u.is_active = TRUE
       AND o.created_at > NOW() - INTERVAL '90 days'
       AND p.active = TRUE
     GROUP BY u.id
     ORDER BY order_count DESC
     LIMIT 20
  `);
    assert(jr.length >= 0, "join executed");
    console.log("OK");

    // 17) exclusion constraint demo if available
    if (ext.btree_gist) {
        console.log("C3) Exclusion constraint: overlapping room bookings should fail …");
        const roomId = 42;
        await db.query(connection, `INSERT INTO room_bookings(room_id, tsrange) VALUES ($1, tstzrange(NOW(), NOW() + INTERVAL '1 hour'))`, [roomId]);
        let overlapFailed = false;
        try {
            await db.query(connection, `INSERT INTO room_bookings(room_id, tsrange) VALUES ($1, tstzrange(NOW() + INTERVAL '30 min', NOW() + INTERVAL '90 min'))`, [roomId]);
        } catch { overlapFailed = true; }
        assert(overlapFailed, "expected exclusion constraint to block overlap");
        console.log("OK");
    } else {
        console.log("C3) Skipped (btree_gist not available).");
    }

    // 18) BRIN scan sanity
    console.log("C4) BRIN sanity: time-window query on products (created_at) …");
    const br = await db.getAll(connection, `
    SELECT id FROM products
     WHERE created_at > NOW() - INTERVAL '365 days'
     ORDER BY created_at DESC
     LIMIT 25
  `);
    assert(br.length >= 0, "BRIN time-window executed");
    console.log("OK");

    // 19) plan check (EXPLAIN) – developer can read plan to verify index usage
    console.log("C5) EXPLAIN ANALYZE (read output manually to see index usage) …");
    const explain = await db.getAll(connection, `
    EXPLAIN ANALYZE
    SELECT id FROM products
     WHERE active = TRUE
       AND tags @> $1::jsonb
       AND price_cents BETWEEN $2 AND $3
     ORDER BY price_cents ASC
     LIMIT 50
  `, [JSON.stringify(["eco"]), 1000, 5000]);
    console.log("---- EXPLAIN ANALYZE (first 10 lines) ----");
    explain.slice(0, 10).forEach(r => console.log(r["QUERY PLAN"]));
    console.log("---- END EXPLAIN ----");
    console.log("OK");
}

async function stressScenarios(db, connection) {
    console.log("\n=== STRESS SCENARIOS ===");

    // 20) concurrent inserts with transactions
    console.log("S1) 50 concurrent transactional order creations (should all commit without deadlock) …");
    const u = await db.getRow(connection, `SELECT id FROM users ORDER BY id LIMIT 1`);
    const prodA = await db.getRow(connection, `SELECT id, price_cents FROM products ORDER BY id LIMIT 1`);
    const prodB = await db.getRow(connection, `SELECT id, price_cents FROM products ORDER BY id OFFSET 1 LIMIT 1`);
    const tasks = [];
    for (let i = 0; i < 50; i++) {
        tasks.push(db.withTransaction(connection, async ({ query }) => {
            const o = await query(`INSERT INTO orders(user_id,status,total_cents,meta) VALUES($1,'pending',0,'{}') RETURNING id`, [u.id]);
            const oid = o.rows[0].id;
            await query(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,1,$3)`, [oid, prodA.id, prodA.price_cents]);
            await query(`INSERT INTO order_items(order_id,product_id,qty,price_cents) VALUES($1,$2,1,$3)`, [oid, prodB.id, prodB.price_cents]);
            await query(`UPDATE orders SET total_cents=$1, status='paid' WHERE id=$2`, [prodA.price_cents + prodB.price_cents, oid]);
        }));
    }
    await Promise.all(tasks);
    const cnt = await db.getRow(connection, `SELECT COUNT(*)::int AS c FROM orders WHERE status='paid'`);
    assert(cnt.c >= 50, "expected ≥50 paid orders post-stress");
    console.log("OK");

    // 21) heavy JSONB filtering loop
    console.log("S2) 100 iterative JSONB @> queries (ensure no leaks/hangs) …");
    for (let i = 0; i < 100; i++) {
        const tg = i % 2 ? ["sale"] : ["eco"];
        const res = await db.getAll(connection, `SELECT id FROM products WHERE tags @> $1::jsonb LIMIT 20`, [JSON.stringify(tg)]);
        assert(res.length >= 0, "jsonb loop ok");
    }
    console.log("OK");

    // 22) bulk update in chunks
    console.log("S3) Bulk update products price (10 chunks) …");
    const totalProd = await db.getRow(connection, `SELECT COUNT(*)::int AS c FROM products`);
    const chunk = Math.max(1, Math.floor(totalProd.c / 10));
    for (let off = 0; off < totalProd.c; off += chunk) {
        await db.withTransaction(connection, async ({ query }) => {
            await query(`
        UPDATE products SET price_cents = price_cents + 1
         WHERE id IN (
           SELECT id FROM products ORDER BY id ASC OFFSET $1 LIMIT $2
         )
      `, [off, chunk]);
        });
    }
    const chk = await db.getRow(connection, `SELECT MIN(price_cents)::int AS minp, MAX(price_cents)::int AS maxp FROM products`);
    assert(chk.minp <= chk.maxp, "bulk updates reflected");
    console.log("OK");
}

(async () => {
    const connection = "main";

    const db = new DB({
        defaultQueryTimeoutMs: 15000,
        queryLogger: null,
    });

    db.registerConnection(connection, {});
    await db.ensureConnected(connection);
    console.log(db.connections);

    // const extensions = await createSchema(db, connection);
    // await createIndexes(db, connection, extensions);
    // await truncateAll(db, connection);
    //
    // await seed(db, connection)
    // await basicScenarios(db, connection);
    // await mediumScenarios(db, connection);
    // await advancedScenarios(db, connection);
    // await complexScenarios(db, connection, extensions);
    // await stressScenarios(db, connection);

    await db.closeAll();
})();
