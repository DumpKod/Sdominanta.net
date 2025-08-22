// Sdominanta.net/pa2ap/daemon/sdom-p2p.js
const WebSocket = require('ws'); // Для простоты локальной связи, в реальном libp2p будет свой транспорт

const P2P_WS_PORT = process.env.P2P_WS_PORT || 9090; // Порт для связи с Python-адаптером

const wss = new WebSocket.Server({ port: P2P_WS_PORT });

console.log(`Pa2ap Daemon WebSocket server started on port ${P2P_WS_PORT}`);

// Имитация P2P-сети (без реального libp2p для MVP)
// В реальной реализации здесь будет инициализация libp2p, DHT, Gossipsub
const connectedPeers = new Set(); // Имитация подключенных пиров
const topicSubscribers = new Map(); // Имитация подписок на топики

wss.on('connection', ws => {
    console.log('Python adapter connected to Pa2ap Daemon WebSocket');
    
    ws.on('message', message => {
        const msg = JSON.parse(message);
        console.log('Received from Python adapter:', msg);

        switch (msg.type) {
            case 'publish':
                // Имитация публикации в топик
                if (topicSubscribers.has(msg.topic)) {
                    topicSubscribers.get(msg.topic).forEach(subWs => {
                        if (subWs !== ws) { // Не отправляем сообщение обратно отправителю
                            subWs.send(JSON.stringify({ type: 'message', topic: msg.topic, data: msg.data }));
                        }
                    });
                }
                break;
            case 'subscribe':
                if (!topicSubscribers.has(msg.topic)) {
                    topicSubscribers.set(msg.topic, new Set());
                }
                topicSubscribers.get(msg.topic).add(ws);
                console.log(`Python adapter subscribed to topic: ${msg.topic}`);
                break;
            case 'get_peers':
                // Имитация возврата списка пиров
                ws.send(JSON.stringify({ type: 'peers_list', peers: Array.from(connectedPeers) }));
                break;
            case 'announce':
                connectedPeers.add(msg.peerId);
                console.log(`Peer announced: ${msg.peerId}`);
                // Имитация публикации анонса в sdom/agents/announce
                if (topicSubscribers.has('sdom/agents/announce')) {
                    topicSubscribers.get('sdom/agents/announce').forEach(subWs => {
                        if (subWs !== ws) {
                            subWs.send(JSON.stringify({ type: 'message', topic: 'sdom/agents/announce', data: { peerId: msg.peerId, data: msg.data } }));
                        }
                    });
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log('Python adapter disconnected');
        // Удаляем ws из всех подписок
        topicSubscribers.forEach(subs => subs.delete(ws));
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});