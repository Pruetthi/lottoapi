const admin = require("firebase-admin");
//const serviceAccount = require("./.json");

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
});

const firestore = admin.firestore();
const fs = require("fs");
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const os = require("os");
const crypto = require("crypto");
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;
const multer = require("multer");
const path = require("path");

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


app.use(cors());
app.use(express.json());


const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});



db.connect((err) => {
    if (err) {
        console.error("❌ Database connection failed:", err);
        return;
    }
    console.log("✅ Connected to MySQL Database!");
});

app.get("/users", (req, res) => {
    const sql = "SELECT * FROM users";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ data: results });
    });
});


app.get("/users/:id", (req, res) => {
    const sql = "SELECT * FROM users WHERE uid = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.length === 0) return res.status(404).json({ message: "User not found" });
        res.json({ data: result[0] });
    });
});


app.post("/users", (req, res) => {
    const { name, email, password, wallet, dob, pic } = req.body;
    const sql = "INSERT INTO users (name, email, password, wallet, dob, pic) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sql, [name, email, password, wallet, dob, pic], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: "User added", id: result.insertId });
    });
});


app.put("/users/:id", (req, res) => {
    const { name, email, password, wallet, dob, pic } = req.body;
    const sql = "UPDATE users SET name = ?, email = ?, password = ?, wallet = ?, dob = ?, pic = ? WHERE id = ?";
    db.query(sql, [name, email, password, wallet, dob, pic, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "User updated" });
    });
});




const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + path.extname(file.originalname);
        cb(null, uniqueName);
    },
});
const upload = multer({ storage });


app.post("/register", upload.single("image"), async (req, res) => {
    const { email, password, user_name, wallet, birthday } = req.body;

    // ตรวจสอบ input เบื้องต้น
    if (!email || !password || !user_name) {
        return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });
    }

    const image = req.file
        ? `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
        : null;

    // แปลง password เป็น hash
    const hashedPassword = crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");

    // SQL insert เข้า MySQL
    const sql = `
        INSERT INTO users (user_name, email, password, wallet, birthday, image, status)
        VALUES (?, ?, ?, ?, ?, ?, 'user')
    `;

    db.query(sql, [user_name, email, hashedPassword, wallet || 0, birthday, image], async (err, result) => {
        if (err) {
            console.error("❌ MySQL insert error:", err);
            return res.status(500).json({ message: "สมัครสมาชิก MySQL ไม่สำเร็จ" });
        }

        const uid = result.insertId;
        console.log("✅ MySQL saved user ID:", uid);

        // บันทึก Firestore
        try {
            await firestore.collection("users").doc(uid.toString()).set({
                uid,
                user_name,
                email,
                wallet: wallet || 0,
                birthday,
                image,
                status: "user",
                created_at: new Date().toISOString()
            });
            console.log("✅ Firestore saved user:", uid);
        } catch (fbErr) {
            console.error("❌ Firestore save error:", fbErr);
            return res.status(500).json({
                message: "Firestore save failed",
                error: fbErr.message
            });
        }

    });
});




app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    // ✅ ตรวจสอบ input
    if (!email || !password) {
        return res.status(400).json({ message: "กรุณากรอก Email และ Password" });
    }

    // ✅ hash password
    const hashedPassword = crypto.createHash("sha256").update(password).digest("hex");

    // ✅ หา user จาก MySQL
    const sql = "SELECT * FROM users WHERE email = ?";
    db.query(sql, [email], async (err, results) => {
        if (err) {
            console.error("❌ Database error:", err);
            return res.status(500).json({ message: "Database error", error: err });
        }

        if (results.length === 0) {
            return res.status(401).json({ message: "ไม่พบ Email นี้ในระบบ" });
        }

        const user = results[0];

        // ✅ ตรวจสอบ password
        if (user.password !== hashedPassword) {
            return res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง" });
        }

        // ✅ ถ้า login สำเร็จ
        const userData = {
            uid: user.uid,
            user_name: user.user_name,
            email: user.email,
            status: user.status,
            wallet: user.wallet,
            image: user.image,
            birthday: user.birthday
        };

        // ✅ optional: sync Firestore (ถ้าต้องการให้ตรงกับ MySQL)
        try {
            await firestore.collection("users").doc(user.uid.toString()).set({
                ...userData,
                updated_at: new Date().toISOString()
            }, { merge: true });
            console.log("✅ Firestore synced for user:", user.uid);
        } catch (fbErr) {
            console.error("⚠️ Firestore sync error:", fbErr);
            // ไม่ return error เพื่อไม่ให้ login fail
        }

        return res.status(200).json({
            message: "เข้าสู่ระบบสำเร็จ",
            user: userData
        });
    });
});




app.post("/createlotto", async (req, res) => {
    const { quantity, price } = req.body;

    if (!quantity || !price) {
        return res.status(400).json({ message: "Please fill all required fields" });
    }
    if (quantity <= 0 || quantity > 1000) {
        return res.status(400).json({ message: "Quantity must be between 1 and 1000" });
    }
    if (price <= 0) {
        return res.status(400).json({ message: "Price must be greater than 0" });
    }

    const generateUniqueNumber = () => {
        return new Promise((resolve, reject) => {
            const number = Math.floor(100000 + Math.random() * 900000);
            const checkSql = `SELECT COUNT(*) as cnt FROM lotto WHERE number = ?`;

            db.query(checkSql, [number], (err, results) => {
                if (err) return reject(err);

                if (results[0].cnt > 0) {
                    // 🔁 ถ้าซ้ำ สุ่มใหม่
                    resolve(generateUniqueNumber());
                } else {
                    resolve(number);
                }
            });
        });
    };

    try {
        const createdLottos = [];

        for (let i = 0; i < quantity; i++) {
            const number = await generateUniqueNumber();

            const sql = `
                INSERT INTO lotto (number, price, status)
                VALUES (?, ?, 'still')
            `;

            const result = await new Promise((resolve, reject) => {
                db.query(sql, [number, price], (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });

            const lid = result.insertId;
            const lottoData = {
                lid,
                number,
                price,
                status: "still",
                created_at: new Date().toISOString()
            };

            createdLottos.push(lottoData);

            // ✅ บันทึก Firestore ทีละใบ
            try {
                await firestore.collection("lotto").doc(lid.toString()).set(lottoData);
            } catch (fbErr) {
                console.error("⚠️ Firestore save error:", fbErr);
                // ไม่ throw เพื่อไม่ให้ MySQL fail
            }
        }

        res.status(200).json({
            message: `${quantity} lottery tickets created successfully`,
            count: quantity,
            price: price,
            lottos: createdLottos
        });

    } catch (err) {
        console.error("❌ Create lotto error:", err);
        res.status(500).json({ message: "Failed to create lottery tickets" });
    }
});


app.get("/lottos", (req, res) => {
    const sql = `SELECT * FROM lotto `;

    db.query(sql, (err, results) => {
        if (err) {
            console.log(err);
            return res.status(500).json({ message: "Failed to fetch lottery tickets" });
        }
        res.status(200).json({
            message: "Lottery tickets fetched successfully",
            data: results
        });
    });
});

app.get("/createlotto", (req, res) => {
    const sql = "SELECT * FROM lotto ORDER BY lid DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ data: results });
    });
});

app.post("/searchlotto", (req, res) => {
    const { number } = req.body;

    if (!number) {
        return res.status(400).json({ message: "number is required" });
    }

    const sql = "SELECT * FROM lotto WHERE CAST(number AS CHAR) LIKE ?";
    const searchValue = `%${number}%`;
    db.query(sql, [searchValue], (err, results) => {
        if (err) {
            console.error("SQL Error:", err);
            return res.status(500).json({ message: err.message });
        }
        res.json({ data: results });
    });
});




app.post("/updateLottoReward", (req, res) => {
    const { rid, lid } = req.body;
    if (!rid || !lid) {
        return res.status(400).json({ message: "กรอกข้อมูลไม่ครบ" });
    }

    const sql = "UPDATE lotto SET rid = ? WHERE lid = ?";
    db.query(sql, [rid, lid], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "อัพเดตรางวัลล้มเหลว" });
        }

        res.status(200).json({
            message: "อัพเดตรางวัลสำเร็จ",
            rid,
            lid
        });
    });
});


app.get("/lottoResult", (req, res) => {
    const sql = "SELECT number, rid FROM lotto WHERE rid IS NOT NULL";
    db.query(sql, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "ไม่สามารถดึงรางวัลได้" });
        }

        res.status(200).json({ data: results });
    });
});



app.post("/buyLotto", (req, res) => {
    const { uid, lid, price } = req.body;

    if (!uid || !lid || !price) {
        return res.status(400).json({ message: "ข้อมูลไม่ครบ" });
    }

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ message: "เริ่ม transaction ล้มเหลว" });

        // 1. ตรวจสอบเงินในกระเป๋า
        db.query("SELECT wallet FROM users WHERE uid = ?", [uid], (err, results) => {
            if (err) return db.rollback(() => res.status(500).json({ message: "ดึงข้อมูลผู้ใช้ล้มเหลว" }));
            if (results.length === 0) return db.rollback(() => res.status(404).json({ message: "ไม่พบผู้ใช้" }));

            const wallet = parseFloat(results[0].wallet);
            if (wallet < price) {
                return db.rollback(() => res.status(400).json({ message: "เงินไม่พอ" }));
            }

            // 2. อัปเดตสถานะล็อตโต้
            const sqlLotto = "UPDATE lotto SET uid = ?, status = 'sell' WHERE lid = ? AND status = 'still'";
            db.query(sqlLotto, [uid, lid], (err, result) => {
                if (err || result.affectedRows === 0) {
                    return db.rollback(() => res.status(400).json({ message: "หวยถูกซื้อไปแล้ว หรือไม่พบข้อมูล" }));
                }

                // 3. หักเงินใน wallet
                const sqlWallet = "UPDATE users SET wallet = wallet - ? WHERE uid = ?";
                db.query(sqlWallet, [price, uid], (err) => {
                    if (err) return db.rollback(() => res.status(500).json({ message: "หักเงินล้มเหลว" }));

                    // 4. Commit MySQL ก่อน
                    db.commit(async (err) => {
                        if (err) return db.rollback(() => res.status(500).json({ message: "commit ล้มเหลว" }));

                        const newWallet = wallet - price;

                        // 5. อัปเดต Firestore (ไม่ทำให้ transaction fail)
                        try {
                            await firestore.collection("users").doc(uid.toString()).set({
                                wallet: newWallet,
                                updated_at: new Date().toISOString()
                            }, { merge: true });

                            await firestore.collection("lotto").doc(lid.toString()).set({
                                uid,
                                lid,
                                price,
                                status: "sell",
                                updated_at: new Date().toISOString()
                            }, { merge: true });

                            console.log("✅ Firestore synced:", { uid, lid });
                        } catch (fbErr) {
                            console.error("⚠️ Firestore sync error:", fbErr);
                            // ไม่ rollback เพื่อไม่ให้ซื้อพัง
                        }

                        res.status(200).json({
                            message: "ซื้อสำเร็จ (MySQL + Firestore)",
                            uid,
                            lid,
                            newWallet
                        });
                    });
                });
            });
        });
    });
});



app.get("/myLotto/:uid", (req, res) => {
    const { uid } = req.params;

    const sql = `
    SELECT l.*, r.reward_type, r.reward_money
    FROM lotto l
    LEFT JOIN reward r ON l.rid = r.rid
    WHERE l.uid = ?
  `;

    db.query(sql, [uid], (err, results) => {
        if (err) return res.status(500).json({ message: "ดึงข้อมูลล้มเหลว" });
        res.json(results);
    });
});


app.post("/claim/:lid", (req, res) => {
    const { lid } = req.params;

    const sql = `
        SELECT l.lid, l.uid, l.status, r.reward_type, r.reward_money
        FROM lotto l
        JOIN reward r ON l.rid = r.rid
        WHERE l.lid = ?
    `;
    db.query(sql, [lid], (err, results) => {
        if (err) return res.status(500).json({ message: "ดึงข้อมูลล้มเหลว" });
        if (results.length === 0) return res.status(404).json({ message: "ไม่พบหวยนี้" });

        const lotto = results[0];

        if (lotto.status === 'claim') {
            return res.status(400).json({ message: "หวยนี้ขึ้นเงินแล้ว" });
        }

        const updateWalletSql = `
            UPDATE users 
            SET wallet = wallet + ? 
            WHERE uid = ?
        `;
        db.query(updateWalletSql, [lotto.reward_money, lotto.uid], (err2) => {
            if (err2) return res.status(500).json({ message: "อัปเดตเงินล้มเหลว" });

            // อัปเดต status ของหวยเป็น claim
            const updateStatusSql = "UPDATE lotto SET status = 'claim' WHERE lid = ?";
            db.query(updateStatusSql, [lid], (err3) => {
                if (err3) return res.status(500).json({ message: "อัปเดตสถานะหวยล้มเหลว" });

                res.status(200).json({
                    message: "รับรางวัลสำเร็จ",
                    reward_type: lotto.reward_type,
                    amount: lotto.reward_money
                });
            });
        });
    });
});



app.get("/admin/rewardedLottos", (req, res) => {
    const sql = `
        SELECT l.lid, l.number, l.status, r.reward_type, r.reward_money,
               u.user_name, u.email
        FROM lotto l
        JOIN reward r ON l.rid = r.rid
        JOIN users u ON l.uid = u.uid
        WHERE l.rid IS NOT NULL
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "ดึงข้อมูลล้มเหลว" });
        }
        res.status(200).json(results);
    });
});

app.post("/resetSystem", async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            db.query("DELETE FROM lotto", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await new Promise((resolve, reject) => {
            db.query("ALTER TABLE lotto AUTO_INCREMENT = 1", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await new Promise((resolve, reject) => {
            db.query("DELETE FROM users WHERE status != 'admin'", (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        res.status(200).json({ message: "รีเซ็ตระบบสำเร็จ" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "รีเซ็ตระบบล้มเหลว", error: err });
    }
});

let ip = "0.0.0.0";
const ips = os.networkInterfaces();
Object.keys(ips).forEach((iface) => {
    ips[iface].forEach((dev) => {
        if (dev.family === "IPv4" && !dev.internal) {
            ip = dev.address;
        }
    });
});

app.listen(port, () => {
    console.log(`🚀 Server running on http://${ip}:${port}`);
});

