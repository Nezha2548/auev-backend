const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',      
    password: '',
    database: 'chuayram_db' 
});

db.connect((err) => {
    if (err) {
        console.error('เชื่อมต่อฐานข้อมูลล้มเหลว:', err.message);
        return;
    }
    console.log('เชื่อมต่อฐานข้อมูล MySQL แล้ว');
});

const PORT = 3000;

app.get('/api/modules', (req, res) => {
    const sql = `
        SELECT 
            m.ModuleBarcode AS serial_no, 
            p.PackTypeID AS typeId, 
            m.PackID AS pack_no, 
            pl.PlateID AS plate, 
            m.ModuleDesc AS status,
            DATE_FORMAT(l.ActionTime, '%d/%m/%Y %H:%i') AS save_date,
            l.Note AS note
        FROM module m
        LEFT JOIN pack p ON m.PackID = p.PackID
        LEFT JOIN plate pl ON p.PlateID = pl.PlateID
        LEFT JOIN (
            SELECT RefModuleID, MAX(ActionTime) as MaxTime 
            FROM systemlog 
            GROUP BY RefModuleID
        ) latest ON m.ModuleID = latest.RefModuleID
        LEFT JOIN systemlog l ON latest.RefModuleID = l.RefModuleID AND latest.MaxTime = l.ActionTime
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("เกิดข้อผิดพลาดในการดึงข้อมูลคลัง:", err);
            return res.status(500).json({ error: err.message });
        }

        const formatted = results.map(row => {
            let typeText = '-';
            if (row.typeId == 3) typeText = 'โมดูลเดี่ยว / อะไหล่';
            else if (row.typeId == 2) typeText = 'มาเป็นคันรถ';
            else if (row.typeId == 1) typeText = 'มาเป็นแบตเตอรี่';

            return {
                serial_no: row.serial_no || '-',
                type: typeText,
                pack_no: row.pack_no || '-',
                plate: row.plate || '-',
                status: row.status || 'อยู่ในคลัง',
                save_date: row.save_date || '-',
                note: row.note || '-'
            };
        });

        res.json(formatted);
    });
});

app.get('/api/search-module/:barcode', (req, res) => {
    db.query(`SELECT * FROM module WHERE ModuleBarcode = ?`, [req.params.barcode], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.json({ status: 'not_found' });
        
        const isExported = results[0].ModuleDesc === 'ส่งออกแล้ว';
        res.json({ status: isExported ? 'exported' : 'in_stock', data: results[0] });
    });
});

app.post('/api/add-module', (req, res) => {
    let { barcode, packageNo, position, packTypeId, plateID, note } = req.body; 

    if (!position || position.trim() === "") position = '-';
    if (!packageNo || packageNo.trim() === "") packageNo = null;

    db.query(`SELECT ModuleID FROM module WHERE ModuleBarcode = ?`, [barcode], (checkErr, existing) => {
        if (checkErr) {
            console.error("SQL Error (Check Exist):", checkErr.message);
            return res.status(500).json({ success: false, message: "ฐานข้อมูลมีปัญหา: " + checkErr.message });
        }
        if (existing.length > 0) return res.json({ success: false, message: "มี Serial No. นี้อยู่ในระบบแล้ว!" });

        const insertModule = (validPackageNo) => {
            db.query(`INSERT INTO module (ModuleBarcode, PackID, Position, ModuleDesc) VALUES (?, ?, ?, ?)`, 
            [barcode, validPackageNo, position, 'อยู่ในคลัง'], (err, result) => {
                if (err) {
                    console.error("SQL Error (Insert Module):", err.message);
                    return res.status(500).json({ success: false, message: "บันทึกข้อมูลไม่สำเร็จ: " + err.message });
                }

                db.query(`INSERT INTO systemlog (ActionType, RefPackID, RefModuleID, Position, PayloadData, Note, ActionTime) VALUES (?, ?, ?, ?, ?, ?, NOW())`, 
                ['เพิ่มข้อมูลเข้าคลัง', validPackageNo, result.insertId, position, null, note || null], (logErr) => {
                    if (logErr) console.error("SQL Error (Insert Log):", logErr.message);
                });

                res.json({ success: true, message: "บันทึกข้อมูลสำเร็จ" });
            });
        };

        const handlePackageAndPlate = () => {
            if (packageNo === null) return insertModule(null);

            if (plateID && plateID.trim() !== '') {
                db.query(`SELECT PlateID FROM plate WHERE PlateID = ?`, [plateID], (plateErr, plateRes) => {
                    if (plateErr) {
                        console.error("SQL Error (Check Plate):", plateErr.message);
                        return res.status(500).json({ success: false, message: "Error Check Plate" });
                    }
                    
                    let finalPlateID = plateRes.length > 0 ? plateRes[0].PlateID : null;
                    
                    const processPack = (pID) => {
                        db.query(`SELECT PackID FROM pack WHERE PackID = ?`, [packageNo], (packErr, packResults) => {
                            if (packErr) {
                                console.error("SQL Error (Check Pack):", packErr.message);
                                return res.status(500).json({ success: false, message: "Error Check Pack" });
                            }
                            if (packResults.length > 0) {
                                if (pID) db.query(`UPDATE pack SET PlateID = ? WHERE PackID = ?`, [pID, packageNo], (updErr) => {
                                    if(updErr) console.error("SQL Error (Update Pack Plate):", updErr.message);
                                });
                                insertModule(packageNo);
                            } else {
                                db.query(`INSERT INTO pack (PackID, PackTypeID, PlateID) VALUES (?, ?, ?)`, [packageNo, packTypeId || '1', pID], (createErr) => {
                                    if (createErr) {
                                        console.error("SQL Error (Create Pack):", createErr.message);
                                        return res.status(500).json({ success: false, message: "สร้าง Package ไม่สำเร็จ: " + createErr.message });
                                    }
                                    insertModule(packageNo);
                                });
                            }
                        });
                    };

                    if (finalPlateID) {
                        processPack(finalPlateID);
                    } else {
                        db.query(`INSERT INTO plate (PlateID) VALUES (?)`, [plateID], (insErr, insRes) => {
                            if (insErr) {
                                console.error("SQL Error (Insert Plate):", insErr.message);
                                return res.status(500).json({ success: false, message: "สร้างป้ายทะเบียนไม่สำเร็จ: " + insErr.message });
                            }
                            processPack(plateID);
                        });
                    }
                });
            } else {
                db.query(`SELECT PackID FROM pack WHERE PackID = ?`, [packageNo], (packErr, packResults) => {
                    if (packErr) {
                        console.error("SQL Error (Check Pack No Plate):", packErr.message);
                        return res.status(500).json({ success: false, message: packErr.message });
                    }
                    if (packResults.length > 0) return insertModule(packageNo);
                    db.query(`INSERT INTO pack (PackID, PackTypeID, PlateID) VALUES (?, ?, NULL)`, [packageNo, packTypeId || '1'], (createErr) => {
                        if (createErr) {
                            console.error("❌ SQL Error (Create Pack No Plate):", createErr.message);
                            return res.status(500).json({ success: false, message: createErr.message });
                        }
                        insertModule(packageNo);
                    });
                });
            }
        };

        handlePackageAndPlate();
    });
});

app.get('/api/module-history/:barcode', (req, res) => {
    const sql = `
        SELECT 
            m.ModuleBarcode AS serial, 
            l.RefPackID AS package, 
            l.Position AS position, 
            l.PayloadData AS payload, 
            l.Note AS note, 
            l.ActionType AS actionType, 
            p.PackTypeID AS packTypeId,
            pl.PlateID AS packPlateNo, 
            DATE_FORMAT(l.ActionTime, '%d/%m/%Y %H:%i') AS date 
        FROM systemlog l
        JOIN module m ON l.RefModuleID = m.ModuleID
        LEFT JOIN pack p ON l.RefPackID = p.PackID
        LEFT JOIN plate pl ON p.PlateID = pl.PlateID
        WHERE m.ModuleBarcode = ?
        ORDER BY l.ActionTime DESC
    `;

    db.query(sql, [req.params.barcode], (err, results) => {
        if (err) {
            console.error("SQL Error (History):", err.message);
            return res.status(500).json({ error: err.message }); 
        }

        const formattedResults = results.map(row => {
            let plateVal = '-';
            if (row.payload && row.payload.startsWith('{')) {
                try {
                    const parsed = JSON.parse(row.payload);
                    if (parsed.plateID && parsed.plateID !== '-') plateVal = parsed.plateID;
                    else if (parsed.plateNo && parsed.plateNo !== '-') plateVal = parsed.plateNo;
                } catch (e) {}
            }
            if (plateVal === '-' && row.packPlateNo) plateVal = row.packPlateNo;

            let importType = row.packTypeId == 3 ? 'โมดูลเดี่ยว / อะไหล่' : (row.packTypeId == 2 ? 'มาเป็นคันรถ' : (row.packTypeId == 1 ? 'มาเป็นแบตเตอรี่' : '-'));
            let displayStatus = (row.actionType === 'ส่งออก') ? 'ส่งออกแล้ว' : ((row.actionType === 'เพิ่มข้อมูลเข้าคลัง' || row.actionType === 'รับเข้าคลัง' || row.actionType === 'แก้ไขข้อมูล') ? 'อยู่ในคลัง' : row.actionType);
            let cleanNote = row.note || '-';
            if (cleanNote !== '-') {
                let parts = cleanNote.split('|').map(p => p.trim());
                const userNotes = parts.filter(p => !p.includes('ประเภทการนำเข้า') && !p.includes('ป้ายทะเบียน'));
                cleanNote = userNotes.length > 0 ? userNotes.join(' | ') : '-';
            }

            return { ...row, plate: plateVal, importType, status: displayStatus, note: cleanNote };
        });

        res.json(formattedResults);
    });
});

app.put('/api/update-module/:barcode', (req, res) => {
    let { packageNo, position, note } = req.body;
    if (!position || position.trim() === "") position = '-';
    if (!packageNo || packageNo.trim() === "") packageNo = null;

    db.query(`UPDATE module SET PackID = ?, Position = ?, ModuleDesc = 'อยู่ในคลัง' WHERE ModuleBarcode = ?`, [packageNo, position, req.params.barcode], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "ไม่พบโมดูล" });

        db.query(`SELECT ModuleID FROM module WHERE ModuleBarcode = ?`, [req.params.barcode], (idErr, idResults) => {
            if (!idErr && idResults.length > 0) {
                db.query(`INSERT INTO systemlog (ActionType, RefPackID, RefModuleID, Position, PayloadData, Note, ActionTime) VALUES (?, ?, ?, ?, ?, ?, NOW())`, 
                ['แก้ไขข้อมูล', packageNo, idResults[0].ModuleID, position, null, note || null], () => {});
            }
        });
        res.json({ success: true, message: "แก้ไขข้อมูลสำเร็จ" });
    });
});

app.post('/api/export-module/:barcode', (req, res) => {
    let { packageNo, position, carModel, plateID, customerName, note } = req.body;
    if (!packageNo || packageNo.trim() === "") packageNo = null;
    if (!position || position.trim() === "") position = '-';

    const executeExport = (modId, validPackageNo) => {
        const payloadDataObj = JSON.stringify({ carModel: carModel || '-', plateID: plateID || '-', customerName: customerName || '-' });
        db.query(`INSERT INTO systemlog (ActionType, RefPackID, RefModuleID, Position, PayloadData, Note, ActionTime) VALUES (?, ?, ?, ?, ?, ?, NOW())`, 
        ['ส่งออก', validPackageNo, modId, position, payloadDataObj, note || null], (logErr) => {
            if (logErr) return res.status(500).json({ success: false, message: logErr.message });
            db.query(`UPDATE module SET PackID = ?, Position = ?, ModuleDesc = 'ส่งออกแล้ว' WHERE ModuleID = ?`, [validPackageNo, position, modId], (updateErr) => {
                if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
                res.json({ success: true, message: "ส่งออกโมดูลสำเร็จ" });
            });
        });
    };

    db.query(`SELECT ModuleID FROM module WHERE ModuleBarcode = ?`, [req.params.barcode], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ success: false, message: "ไม่พบโมดูล" });
        const modId = results[0].ModuleID;

        if (packageNo) {
            db.query(`SELECT PackID FROM pack WHERE PackID = ?`, [packageNo], (err, packResults) => {
                if (err || packResults.length === 0) return res.json({ success: false, message: "ไม่พบ Package นี้" });
                executeExport(modId, packageNo);
            });
        } else {
            executeExport(modId, null);
        }
    });
});

app.post('/api/receive-module/:barcode', (req, res) => {
    db.query(`SELECT ModuleID, PackID, Position FROM module WHERE ModuleBarcode = ?`, [req.params.barcode], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ success: false, message: "ไม่พบโมดูล" });
        const { ModuleID, PackID, Position } = results[0];
        
        db.query(`INSERT INTO systemlog (ActionType, RefPackID, RefModuleID, Position, PayloadData, Note, ActionTime) VALUES (?, ?, ?, ?, ?, ?, NOW())`, 
        ['รับเข้าคลัง', PackID, ModuleID, Position || '-', null, 'รับโมดูลกลับเข้าคลังจัดเก็บ'], () => {});

        db.query(`UPDATE module SET ModuleDesc = 'อยู่ในคลัง' WHERE ModuleID = ?`, [ModuleID], (updateErr) => {
            if (updateErr) return res.status(500).json({ success: false, message: updateErr.message });
            res.json({ success: true, message: "รับเข้าคลังสำเร็จ" });
        });
    });
});

app.delete('/api/delete-module/:barcode', (req, res) => {
    db.query(`DELETE FROM module WHERE ModuleBarcode = ?`, [req.params.barcode], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "ไม่พบโมดูล" });
        res.json({ success: true, message: "ลบข้อมูลสำเร็จ" });
    });
});

app.post('/api/add-pack', (req, res) => {
    let { packId, packTypeId, plateId } = req.body;
    if (!packId || packId.trim() === "") return res.status(400).json({ success: false, message: "ระบุรหัส Package No." });

    db.query(`SELECT PackID FROM pack WHERE PackID = ?`, [packId], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) return res.json({ success: false, message: "มี Package นี้แล้ว!" });

        db.query(`INSERT INTO pack (PackID, PackTypeID, PlateID) VALUES (?, ?, ?)`, [packId, packTypeId || null, plateId || null], (insertErr) => {
            if (insertErr) return res.status(500).json({ success: false, message: insertErr.message });
            res.json({ success: true, message: "สร้าง Package สำเร็จ" });
        });
    });
});

app.get('/api/pack-modules/:packId', (req, res) => {
    db.query(`SELECT ModuleBarcode AS serial, Position AS position, ModuleDesc AS status FROM module WHERE PackID = ?`, [req.params.packId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/all-history', (req, res) => {
    const sql = `
        SELECT 
            m.ModuleBarcode AS serial, 
            l.RefPackID AS packageNo, 
            l.Position AS position, 
            l.PayloadData AS payload, 
            l.Note AS note, 
            l.ActionType AS actionType, 
            pl.PlateID AS packPlateNo, 
            DATE_FORMAT(l.ActionTime, '%d/%m/%Y %H:%i') AS date 
        FROM systemlog l
        LEFT JOIN module m ON l.RefModuleID = m.ModuleID
        LEFT JOIN pack p ON l.RefPackID = p.PackID
        LEFT JOIN plate pl ON p.PlateID = pl.PlateID
        ORDER BY l.ActionTime DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message }); 

        const formattedResults = results.map(row => {
            let plateVal = '-';
            if (row.payload && row.payload.startsWith('{')) {
                try {
                    const parsed = JSON.parse(row.payload);
                    if (parsed.plateID && parsed.plateID !== '-') plateVal = parsed.plateID;
                } catch (e) {}
            }
            if (plateVal === '-' && row.packPlateNo) plateVal = row.packPlateNo;

            let displayStatus = row.actionType;
            if (row.actionType === 'ส่งออก') displayStatus = 'ส่งออกแล้ว';
            else if (['เพิ่มข้อมูลเข้าคลัง', 'รับเข้าคลัง', 'แก้ไขข้อมูล'].includes(row.actionType)) displayStatus = 'อยู่ในคลัง';

            let cleanNote = row.note || '-';
            if (cleanNote !== '-') {
                let parts = cleanNote.split('|').map(p => p.trim());
                const userNotes = parts.filter(p => !p.includes('ประเภทการนำเข้า') && !p.includes('ป้ายทะเบียน'));
                cleanNote = userNotes.length > 0 ? userNotes.join(' | ') : '-';
            }

            return { 
                serial: row.serial || '-',
                packageNo: row.packageNo || '-',
                position: row.position || '-',
                plate: plateVal,
                status: displayStatus,
                date: row.date,
                actionBy: 'Admin',
                note: cleanNote 
            };
        });

        res.json(formattedResults);
    });
});

app.get('/api/dashboard-stats', (req, res) => {
    const countSql = `
        SELECT 
            COUNT(*) AS totalModules,
            SUM(CASE WHEN ModuleDesc = 'อยู่ในคลัง' THEN 1 ELSE 0 END) AS inStock,
            SUM(CASE WHEN ModuleDesc = 'ส่งออกแล้ว' THEN 1 ELSE 0 END) AS exported
        FROM module
    `;

    const chartSql = `
        SELECT 
            DATE_FORMAT(ActionTime, '%d/%m/%Y') AS date,
            COUNT(*) AS amount
        FROM systemlog
        WHERE ActionType = 'ส่งออก'
        GROUP BY DATE(ActionTime)
        ORDER BY ActionTime DESC
        LIMIT 7
    `;

    db.query(countSql, (err, countResult) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query(chartSql, (err, chartResult) => {
            if (err) return res.status(500).json({ error: err.message });

            res.json({
                stats: countResult[0] || { totalModules: 0, inStock: 0, exported: 0 },
                exportDaily: chartResult
            });
        });
    });
});

app.get('/api/user-profile', (req, res) => {
    const userInfo = {
        name: 'นาย สมชาย บุญชู',
        position: 'พนักงานบันทึกข้อมูล',
        age: '22 ปี',
        phone: '0912345678'
    };

    const sql = `
        SELECT 
            m.ModuleBarcode AS serial, 
            l.ActionType AS actionType, 
            l.RefPackID AS pack, 
            DATE_FORMAT(l.ActionTime, '%d/%m/%Y %H:%i') AS date, 
            l.Note AS note 
        FROM systemlog l
        LEFT JOIN module m ON l.RefModuleID = m.ModuleID
        ORDER BY l.ActionTime DESC
        LIMIT 20
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        const history = results.map(row => {
            let displayStatus = row.actionType;
            if (row.actionType === 'ส่งออก') displayStatus = 'ส่งออกแล้ว';
            else if (['เพิ่มข้อมูลเข้าคลัง', 'รับเข้าคลัง', 'แก้ไขข้อมูล'].includes(row.actionType)) displayStatus = 'อยู่ในคลัง';

            return {
                serial: row.serial || '-',
                status: displayStatus,
                pack: row.pack || '-',
                date: row.date || '-',
                user: 'นาย สมชาย บุญชู',
                note: row.note || '-'
            };
        });

        res.json({
            profile: userInfo,
            history: history
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน" });
    }

    const sql = `SELECT * FROM users WHERE Username = ? AND Password = ?`;
    db.query(sql, [username, password], (err, results) => {
        if (err) {
            console.error("Login Error:", err);
            return res.status(500).json({ success: false, message: "ฐานข้อมูลมีปัญหา" });
        }

        if (results.length === 0) {
            return res.json({ success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง!" });
        }

        const user = results[0];
        res.json({ 
            success: true, 
            message: "เข้าสู่ระบบสำเร็จ", 
            user: {
                id: user.UserID,
                username: user.Username,
                name: user.FullName,
                position: user.Position,
                age: user.Age,
                phone: user.Phone
            }
        });
    });
});

app.listen(PORT, () => console.log(`Server กำลังรันอยู่ที่ http://localhost:${PORT}`));