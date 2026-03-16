const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const http = require('http');
const os = require('os');

// =========================================
// CONFIGURATION - USING ENVIRONMENT VARIABLES
// =========================================
const PORT = process.env.PORT || 8080;

// Database Configuration - ALL from environment variables
const DB_CONFIG = {
    host: process.env.DB_HOST || '212.95.55.182',     // Your HostPinnacle server IP
    user: process.env.DB_USER || 'mulacras_mula',      // Your database username
    password: process.env.DB_PASSWORD || '1952Swiss',  // Your database password
    database: process.env.DB_NAME || 'mulacras_mulacrash', // Your database name
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

// =========================================
// GAME STATE
// =========================================
let gameState = {
    status: 'waiting',  // waiting, flying, crashed
    multiplier: 1.00,
    crashPoint: 0,
    roundTimer: 10,
    roundNumber: 1,
    startTime: null,
    endTime: null,
    clients: new Map(),
    bets: new Map()
};

// =========================================
// UTILITY FUNCTIONS
// =========================================
function getServerIPs() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}

// =========================================
// DATABASE CONNECTION
// =========================================
let pool = null;
let dbAvailable = false;

async function connectToHostPinnacleDB() {
    console.log('🔄 Attempting to connect to HostPinnacle database...');
    console.log(`📊 Host: ${DB_CONFIG.host}`);
    console.log(`📊 Database: ${DB_CONFIG.database}`);
    console.log(`📊 User: ${DB_CONFIG.user}`);
    
    try {
        // Create connection pool
        pool = await mysql.createPool(DB_CONFIG);
        
        // Test connection
        const connection = await pool.getConnection();
        console.log('✅ Successfully connected to HostPinnacle database!');
        
        // Test query
        const [rows] = await connection.query('SELECT 1+1 as result');
        console.log('✅ Database query test successful:', rows[0]);
        
        // Create tables if they don't exist
        await connection.query(`
            CREATE TABLE IF NOT EXISTS round_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                round_number INT NOT NULL,
                crash_point DECIMAL(10,2) NOT NULL,
                started_at DATETIME,
                ended_at DATETIME,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create settings table if it doesn't exist
        await connection.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT PRIMARY KEY DEFAULT 1,
                multiplier_type ENUM('random', 'fixed') DEFAULT 'random',
                fixed_crash_point DECIMAL(10,2) DEFAULT 2.00,
                house_edge DECIMAL(5,2) DEFAULT 5.00,
                game_paused BOOLEAN DEFAULT 0,
                risk_profile ENUM('normal', 'low', 'high', 'extreme') DEFAULT 'normal'
            )
        `);
        
        // Insert default settings if not exists
        await connection.query(`
            INSERT IGNORE INTO settings (id) VALUES (1)
        `);
        
        console.log('✅ Tables ready');
        connection.release();
        dbAvailable = true;
        return true;
        
    } catch (err) {
        console.error('❌ Failed to connect to HostPinnacle database:');
        console.error('   Error:', err.message);
        
        if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('   ⚠️  Wrong username or password');
        } else if (err.code === 'ER_BAD_DB_ERROR') {
            console.error('   ⚠️  Database does not exist');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('   ⚠️  Connection refused - HostPinnacle may not allow remote MySQL connections');
            console.error('   💡 Make sure Remote MySQL is enabled in cPanel with these Render IPs:');
            console.error('      54.158.73.147');
            console.error('      52.55.241.89');
            console.error('      18.212.66.77');
        } else if (err.code === 'ETIMEDOUT') {
            console.error('   ⚠️  Connection timeout - HostPinnacle firewall may be blocking');
            console.error('   💡 Add these Render IPs to Remote MySQL in cPanel:');
            console.error('      54.158.73.147');
            console.error('      52.55.241.89');
            console.error('      18.212.66.77');
        }
        
        console.log('⚠️  Game will run WITHOUT database - rounds will not be saved');
        dbAvailable = false;
        return false;
    }
}

// =========================================
// SAVE ROUND TO DATABASE
// =========================================
async function saveRoundToDatabase(roundNumber, crashPoint, startTime, endTime) {
    if (!dbAvailable || !pool) {
        console.log('📝 Round not saved (database unavailable)');
        return false;
    }
    
    try {
        await pool.query(
            'INSERT INTO round_history (round_number, crash_point, started_at, ended_at) VALUES (?, ?, ?, ?)',
            [roundNumber, crashPoint, startTime, endTime]
        );
        console.log('✅ Round saved to database');
        return true;
    } catch (err) {
        console.error('❌ Failed to save round:', err.message);
        return false;
    }
}

// =========================================
// LOAD SETTINGS
// =========================================
async function loadSettings() {
    if (!dbAvailable || !pool) {
        return {
            multiplier_type: 'random',
            fixed_crash_point: 2.0,
            house_edge: 5,
            game_paused: 0,
            risk_profile: 'normal'
        };
    }
    
    try {
        const [rows] = await pool.query('SELECT * FROM settings WHERE id = 1');
        if (rows.length > 0) {
            return rows[0];
        }
        return {
            multiplier_type: 'random',
            fixed_crash_point: 2.0,
            house_edge: 5,
            game_paused: 0,
            risk_profile: 'normal'
        };
    } catch (error) {
        console.error('Error loading settings:', error);
        return {
            multiplier_type: 'random',
            fixed_crash_point: 2.0,
            house_edge: 5,
            game_paused: 0,
            risk_profile: 'normal'
        };
    }
}

// =========================================
// GENERATE CRASH POINT
// =========================================
function generateCrashPoint(settings) {
    if (settings.multiplier_type === 'fixed') {
        return parseFloat(settings.fixed_crash_point);
    } else {
        let crashPoint;
        switch(settings.risk_profile) {
            case 'low':
                crashPoint = 1.2 + (Math.random() * 1.8);
                break;
            case 'high':
                crashPoint = 2.0 + (Math.random() * 48);
                break;
            case 'extreme':
                crashPoint = 3.0 + (Math.random() * 97);
                break;
            default:
                crashPoint = 1.5 + (Math.random() * 8.5);
        }
        // Apply house edge
        crashPoint = crashPoint * (1 - (settings.house_edge / 100));
        return parseFloat(crashPoint.toFixed(2));
    }
}

// =========================================
// HTTP SERVER
// =========================================
const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            port: PORT,
            gameState: gameState.status,
            round: gameState.roundNumber,
            multiplier: gameState.multiplier,
            connections: gameState.clients.size,
            dbAvailable: dbAvailable,
            serverIPs: getServerIPs(),
            timestamp: new Date().toISOString()
        }));
    } else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            activeBets: gameState.bets.size,
            activePlayers: gameState.clients.size,
            currentMultiplier: gameState.multiplier,
            nextRound: gameState.roundTimer,
            roundNumber: gameState.roundNumber,
            dbAvailable: dbAvailable
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>MulaCrash Game Server</title>
                <style>
                    body { font-family: Arial; background: #0a0c0f; color: white; text-align: center; padding: 50px; }
                    h1 { color: #ffd700; }
                    .info { background: #1a1e24; padding: 20px; border-radius: 10px; margin: 20px; display: inline-block; text-align: left; }
                    .status-online { color: #44ff44; }
                    .db-connected { color: #44ff44; }
                    .db-disconnected { color: #ff4444; }
                </style>
            </head>
            <body>
                <h1>🚀 MulaCrash Game Server</h1>
                <div class="info">
                    <p>✅ Status: <span class="status-online">ONLINE</span></p>
                    <p>📡 Port: ${PORT}</p>
                    <p>🌐 Server IP: ${getServerIPs().join(', ')}</p>
                    <p>💾 Database: <span class="${dbAvailable ? 'db-connected' : 'db-disconnected'}">${dbAvailable ? 'CONNECTED' : 'DISCONNECTED'}</span></p>
                    <p>🔄 Round: ${gameState.roundNumber}</p>
                    <p>👥 Connections: ${gameState.clients.size}</p>
                </div>
                <p>🔌 WebSocket: <strong>wss://mulacrash-ws.onrender.com</strong></p>
                <p>📊 <a href="/health" style="color:#ffd700;">Health Check</a></p>
            </body>
            </html>
        `);
    }
});

// =========================================
// WEBSOCKET SERVER
// =========================================
const wss = new WebSocket.Server({ server });

// Broadcast to all clients
function broadcast(data) {
    const message = JSON.stringify(data);
    gameState.clients.forEach((client, id) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (err) {}
        }
    });
}

// Game loop
let lastTimerUpdate = Date.now();
async function gameLoop() {
    try {
        const settings = await loadSettings();
        const now = Date.now();
        
        if (settings.game_paused) {
            if (gameState.status !== 'paused') {
                gameState.status = 'paused';
                broadcast({ type: 'game_paused', message: 'Game paused by admin' });
            }
            setTimeout(gameLoop, 1000);
            return;
        }
        
        switch(gameState.status) {
            case 'waiting':
                if (now - lastTimerUpdate >= 1000) {
                    gameState.roundTimer--;
                    lastTimerUpdate = now;
                    
                    if (gameState.clients.size > 0) {
                        broadcast({ 
                            type: 'timer', 
                            timer: gameState.roundTimer,
                            roundNumber: gameState.roundNumber
                        });
                    }
                }
                
                if (gameState.roundTimer <= 0) {
                    gameState.status = 'flying';
                    gameState.multiplier = 1.00;
                    gameState.startTime = new Date();
                    gameState.crashPoint = generateCrashPoint(settings);
                    gameState.roundNumber++;
                    
                    console.log(`🚀 Round ${gameState.roundNumber} started. Crash point: ${gameState.crashPoint.toFixed(2)}x | Clients: ${gameState.clients.size}`);
                    
                    if (gameState.clients.size > 0) {
                        broadcast({ 
                            type: 'start', 
                            crashPoint: gameState.crashPoint,
                            multiplier: gameState.multiplier,
                            roundNumber: gameState.roundNumber
                        });
                    }
                }
                break;
                
            case 'flying':
                gameState.multiplier += 0.015;
                gameState.multiplier = parseFloat(gameState.multiplier.toFixed(2));
                
                if (gameState.multiplier >= gameState.crashPoint) {
                    gameState.status = 'crashed';
                    gameState.endTime = new Date();
                    
                    console.log(`💥 Round ${gameState.roundNumber} crashed at ${gameState.multiplier.toFixed(2)}x`);
                    
                    // Save to database
                    await saveRoundToDatabase(
                        gameState.roundNumber,
                        gameState.multiplier,
                        gameState.startTime,
                        gameState.endTime
                    );
                    
                    // Clear bets
                    gameState.bets.clear();
                    
                    if (gameState.clients.size > 0) {
                        broadcast({ 
                            type: 'crash', 
                            crashPoint: gameState.multiplier,
                            roundNumber: gameState.roundNumber
                        });
                    }
                    
                    // Prepare next round
                    gameState.status = 'waiting';
                    gameState.roundTimer = 10;
                    lastTimerUpdate = now;
                    
                } else {
                    if (gameState.clients.size > 0) {
                        broadcast({ 
                            type: 'multiplier', 
                            multiplier: gameState.multiplier,
                            roundNumber: gameState.roundNumber
                        });
                    }
                }
                break;
        }
    } catch (err) {
        console.error('❌ Game loop error:', err.message);
    }
    
    setTimeout(gameLoop, 50);
}

// =========================================
// WEBSOCKET CONNECTION HANDLER
// =========================================
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientId = Date.now() + Math.random().toString(36).substr(2, 6);
    
    console.log(`🟢 Client ${clientId} connected from ${clientIp}`);
    gameState.clients.set(clientId, ws);
    
    // Send initial state
    try {
        ws.send(JSON.stringify({
            type: 'state',
            state: {
                status: gameState.status,
                multiplier: gameState.multiplier,
                timer: gameState.roundTimer,
                roundNumber: gameState.roundNumber
            }
        }));
    } catch (err) {}
    
    // Send recent history
    if (dbAvailable) {
        (async () => {
            try {
                const [rows] = await pool.query(
                    'SELECT crash_point FROM round_history ORDER BY id DESC LIMIT 5'
                );
                ws.send(JSON.stringify({
                    type: 'history',
                    history: rows
                }));
            } catch (err) {}
        })();
    }
    
    // Handle messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    break;
                    
                case 'place_bet':
                    const { userId, amount, autoCashout } = data;
                    
                    if (gameState.status === 'waiting' || 
                        (gameState.status === 'flying' && gameState.multiplier < 1.3)) {
                        
                        if (amount >= 10 && amount <= 10000) {
                            gameState.bets.set(clientId, {
                                userId: userId || clientId,
                                amount: amount,
                                autoCashout: autoCashout,
                                placedAt: gameState.multiplier,
                                roundNumber: gameState.roundNumber,
                                cashedOut: false
                            });
                            
                            console.log(`💰 Bet: ${clientId} - KES ${amount}`);
                            
                            ws.send(JSON.stringify({
                                type: 'bet_confirmed',
                                amount: amount,
                                multiplier: gameState.multiplier,
                                roundNumber: gameState.roundNumber
                            }));
                        }
                    }
                    break;
                    
                case 'cashout':
                    const bet = gameState.bets.get(clientId);
                    if (bet && !bet.cashedOut && gameState.status === 'flying') {
                        bet.cashedOut = true;
                        const winAmount = bet.amount * gameState.multiplier;
                        
                        console.log(`💰 Cashout: ${clientId} - KES ${winAmount.toFixed(2)} at ${gameState.multiplier}x`);
                        
                        ws.send(JSON.stringify({
                            type: 'cashout_success',
                            winAmount: winAmount,
                            multiplier: gameState.multiplier,
                            roundNumber: gameState.roundNumber
                        }));
                        
                        gameState.bets.delete(clientId);
                    }
                    break;
            }
        } catch (err) {}
    });
    
    ws.on('close', () => {
        console.log(`🔴 Client ${clientId} disconnected`);
        gameState.clients.delete(clientId);
        gameState.bets.delete(clientId);
    });
    
    ws.on('error', (err) => {
        console.log(`❌ WebSocket error for ${clientId}:`, err.message);
    });
});

// =========================================
// START SERVER
// =========================================
async function startServer() {
    console.log('=================================');
    console.log('   MulaCrash WebSocket Server');
    console.log('=================================');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Server IPs: ${getServerIPs().join(', ')}`);
    console.log(`💾 Connecting to HostPinnacle DB: ${DB_CONFIG.host}`);
    console.log('=================================');
    
    // Connect to database
    await connectToHostPinnacleDB();
    
    // Start server
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Server listening on port ${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`🔌 WebSocket URL: wss://mulacrash-ws.onrender.com`);
        console.log('=================================');
        
        // Start game loop
        console.log('🎮 Starting game loop...');
        setTimeout(gameLoop, 1000);
    });
}

// Error handling
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled rejection:', err.message);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Notify clients
    broadcast({ type: 'shutdown', message: 'Server is shutting down' });
    
    // Close all connections
    wss.clients.forEach(client => {
        client.close();
    });
    
    // Close server
    server.close(() => {
        console.log('✅ Server closed');
        if (pool) {
            pool.end().then(() => {
                console.log('✅ Database connections closed');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
});

process.on('SIGTERM', () => {
    process.emit('SIGINT');
});

// Start the server
startServer();