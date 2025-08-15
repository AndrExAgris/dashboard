const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const si = require('systeminformation');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    // Configurações otimizadas para WebSocket
    perMessageDeflate: {
        threshold: 1024,
        concurrencyLimit: 10,
    },
    maxPayload: 16 * 1024 * 1024 // 16MB
});

// Configurações
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DISK1_PATH = process.env.DISK1_PATH || '/';
const DISK2_PATH = process.env.DISK2_PATH || '/mnt/storage';
const DISK1_NAME = process.env.DISK1_NAME || 'Sistema';
const DISK2_NAME = process.env.DISK2_NAME || 'Storage';

// Middleware
app.use(cors());
app.use(express.json());
// Servir arquivos estáticos incluindo imagens
app.use(express.static(path.join(__dirname, 'public')));

// Cache otimizado para dados YAML
let yamlCache = {
    dashboard: null,
    bookmarks: null,
    lastUpdate: 0,
    isUpdating: false
};

// Cache para dados do sistema
let systemDataCache = {
    data: null,
    lastUpdate: 0
};

// Função otimizada para carregar arquivos YAML
async function loadYamlFile(filename) {
    try {
        const filePath = path.join(DATA_DIR, filename);
        const stats = await fs.stat(filePath);
        const fileContent = await fs.readFile(filePath, 'utf8');
        const data = yaml.load(fileContent);
        return { data, mtime: stats.mtime.getTime() };
    } catch (error) {
        console.error(`Erro ao carregar ${filename}:`, error.message);
        return { data: null, mtime: 0 };
    }
}

// Atualizar cache de YAML com verificação de modificação
async function updateYamlCache() {
    const now = Date.now();
    
    // Evita atualizações concorrentes
    if (yamlCache.isUpdating) return;
    
    // Atualiza cache a cada 30 segundos ou se nunca foi carregado
    if (now - yamlCache.lastUpdate > 30000 || !yamlCache.dashboard) {
        yamlCache.isUpdating = true;
        
        try {
            const [dashboardResult, bookmarksResult] = await Promise.all([
                loadYamlFile('dashboard.yaml'),
                loadYamlFile('bookmarks.yaml')
            ]);
            
            yamlCache.dashboard = dashboardResult.data || { Dashboard: [] };
            yamlCache.bookmarks = bookmarksResult.data || { categories: [] };
            yamlCache.lastUpdate = now;
        } catch (error) {
            console.error('Erro ao atualizar cache YAML:', error);
        } finally {
            yamlCache.isUpdating = false;
        }
    }
}

// Rotas API com cache
app.get('/api/dashboard', async (req, res) => {
    try {
        await updateYamlCache();
        res.json(yamlCache.dashboard || { Dashboard: [] });
    } catch (error) {
        console.error('Erro na rota /api/dashboard:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

app.get('/api/bookmarks', async (req, res) => {
    try {
        await updateYamlCache();
        res.json(yamlCache.bookmarks || { categories: [] });
    } catch (error) {
        console.error('Erro na rota /api/bookmarks:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Função otimizada para obter informações do sistema
async function getSystemInfo() {
    const now = Date.now();
    
    // Cache de 1 segundo para evitar múltiplas chamadas simultâneas
    if (systemDataCache.data && (now - systemDataCache.lastUpdate) < 1000) {
        return systemDataCache.data;
    }

    try {
        // Executar chamadas em paralelo para melhor performance
        const [cpuLoad, cpuTemp, mem, disks, processes, networkStats] = await Promise.all([
            si.currentLoad(),
            si.cpuTemperature().catch(() => ({ main: 0 })), // Fallback se temperatura não disponível
            si.mem(),
            si.fsSize(),
            si.processes(),
            si.networkStats().catch(() => [{ rx_sec: 0, tx_sec: 0 }]) // Fallback para rede
        ]);
        
        // Encontrar discos específicos de forma mais eficiente
        const disk1 = disks.find(d => d.mount === DISK1_PATH) || disks[0] || {
            size: 0, used: 0, available: 0, use: 0
        };
        
        const disk2 = disks.find(d => d.mount === DISK2_PATH) || {
            size: 0, used: 0, available: 0, use: 0
        };
        
        const primaryNetwork = networkStats[0] || { rx_sec: 0, tx_sec: 0 };
        
        const systemData = {
            cpu: {
                usage: parseFloat(cpuLoad.currentLoad.toFixed(1)),
                temp: cpuTemp.main || 0,
                cores: cpuLoad.cpus ? cpuLoad.cpus.map(c => parseFloat(c.load.toFixed(1))) : []
            },
            memory: {
                total: mem.total,
                used: mem.active, // Usando mem.active que é mais preciso
                free: mem.free,
                percent: parseFloat(((mem.active / mem.total) * 100).toFixed(1))
            },
            disk1: {
                name: DISK1_NAME,
                total: disk1.size,
                used: disk1.used,
                free: disk1.available,
                percent: parseFloat((disk1.use || 0).toFixed(1))
            },
            disk2: {
                name: DISK2_NAME,
                total: disk2.size,
                used: disk2.used,
                free: disk2.available,
                percent: parseFloat((disk2.use || 0).toFixed(1))
            },
            processes: {
                total: processes.all || 0,
                running: processes.running || 0,
                sleeping: processes.sleeping || 0
            },
            network: {
                download: primaryNetwork.rx_sec || 0,
                upload: primaryNetwork.tx_sec || 0
            },
            timestamp: now
        };

        // Atualizar cache
        systemDataCache.data = systemData;
        systemDataCache.lastUpdate = now;
        
        return systemData;
        
    } catch (error) {
        console.error('Erro ao obter informações do sistema:', error.message);
        
        // Retornar dados padrão em caso de erro
        const fallbackData = {
            cpu: { usage: 0, temp: 0, cores: [] },
            memory: { total: 0, used: 0, free: 0, percent: 0 },
            disk1: { name: DISK1_NAME, total: 0, used: 0, free: 0, percent: 0 },
            disk2: { name: DISK2_NAME, total: 0, used: 0, free: 0, percent: 0 },
            processes: { total: 0, running: 0, sleeping: 0 },
            network: { download: 0, upload: 0 },
            timestamp: now
        };
        
        systemDataCache.data = fallbackData;
        systemDataCache.lastUpdate = now;
        
        return fallbackData;
    }
}

// Set para rastrear clientes conectados
const connectedClients = new Set();

// WebSocket otimizado para atualizações em tempo real
wss.on('connection', (ws, req) => {
    console.log(`Cliente WebSocket conectado (${connectedClients.size + 1} total)`);
    connectedClients.add(ws);
    
    // Enviar dados iniciais
    getSystemInfo().then(data => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }).catch(error => {
        console.error('Erro ao enviar dados iniciais:', error);
    });
    
    // Configurar ping/pong para manter conexão viva
    let isAlive = true;
    ws.on('pong', () => { isAlive = true; });
    
    const pingInterval = setInterval(() => {
        if (!isAlive) {
            console.log('Cliente não respondeu ao ping, terminando conexão');
            ws.terminate();
            return;
        }
        
        isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000); // Ping a cada 30 segundos
    
    ws.on('close', () => {
        console.log(`Cliente WebSocket desconectado (${connectedClients.size - 1} restantes)`);
        connectedClients.delete(ws);
        clearInterval(pingInterval);
    });
    
    ws.on('error', (error) => {
        console.error('Erro no WebSocket do cliente:', error.message);
        connectedClients.delete(ws);
        clearInterval(pingInterval);
    });
});

// Broadcast otimizado para todos os clientes conectados
async function broadcastSystemData() {
    if (connectedClients.size === 0) return;
    
    try {
        const data = await getSystemInfo();
        const message = JSON.stringify(data);
        
        // Enviar para todos os clientes conectados
        const deadClients = [];
        
        for (const client of connectedClients) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                } catch (error) {
                    console.error('Erro ao enviar dados para cliente:', error);
                    deadClients.push(client);
                }
            } else {
                deadClients.push(client);
            }
        }
        
        // Remover clientes mortos
        deadClients.forEach(client => connectedClients.delete(client));
        
    } catch (error) {
        console.error('Erro no broadcast:', error);
    }
}

// Iniciar broadcast a cada 2 segundos apenas se houver clientes
setInterval(broadcastSystemData, 2000);

// Rota para obter background aleatório
app.get('/api/random-background', async (req, res) => {
    try {
        const imagesDir = path.join(__dirname, 'public', 'images');
        
        // Verificar se o diretório existe
        try {
            await fs.access(imagesDir);
        } catch {
            return res.json({ backgroundUrl: null });
        }
        
        const files = await fs.readdir(imagesDir);
        const gifFiles = files.filter(file => 
            file.toLowerCase().endsWith('.gif')
        );
        
        if (gifFiles.length === 0) {
            return res.json({ backgroundUrl: null });
        }
        
        // Selecionar GIF aleatório
        const randomGif = gifFiles[Math.floor(Math.random() * gifFiles.length)];
        const backgroundUrl = `/images/${randomGif}`;
        
        res.json({ backgroundUrl });
        
    } catch (error) {
        console.error('Erro ao obter background aleatório:', error);
        res.json({ backgroundUrl: null });
    }
});

// Rota de API para informações do sistema (fallback)
app.get('/api/system', async (req, res) => {
    try {
        const data = await getSystemInfo();
        res.json(data);
    } catch (error) {
        console.error('Erro na rota /api/system:', error);
        res.status(500).json({ error: 'Erro ao obter dados do sistema' });
    }
});

// Rota de health check melhorada
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connectedClients: connectedClients.size
    });
});

// Middleware de tratamento de erro global
app.use((error, req, res, next) => {
    console.error('Erro não tratado:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard rodando em http://localhost:${PORT}`);
    console.log(`Monitorando discos: ${DISK1_NAME} (${DISK1_PATH}) e ${DISK2_NAME} (${DISK2_PATH})`);
    console.log(`Diretório de imagens: ${path.join(__dirname, 'public', 'images')}`);
});

// Graceful shutdown melhorado
const gracefulShutdown = (signal) => {
    console.log(`${signal} recebido, iniciando shutdown graceful...`);
    
    server.close(() => {
        console.log('Servidor HTTP fechado');
        
        // Fechar todas as conexões WebSocket
        connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1000, 'Servidor sendo desligado');
            }
        });
        
        console.log('Todas as conexões WebSocket fechadas');
        console.log('Shutdown completo');
        process.exit(0);
    });
    
    // Forçar saída após 10 segundos se o shutdown não completar
    setTimeout(() => {
        console.error('Forçando saída após timeout de shutdown');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Tratamento de exceções não capturadas
process.on('uncaughtException', (error) => {
    console.error('Exceção não capturada:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejection não tratada:', reason);
    // Não forçar saída aqui, apenas logar
});