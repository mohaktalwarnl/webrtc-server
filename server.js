// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // Adjust for your production domain
});

// --- Mediasoup setup ---
let workers = [];
let nextWorkerIdx = 0;

/**
 * @type {Map<string, { router: mediasoup.types.Router, peers: Map<string, any> }>}
 */
const rooms = new Map();

/**
 * --- Main application logic ---
 */
async function run() {
  await createWorkers();

  io.on('connection', (socket) => {
    console.log(`Client connected [socketId:${socket.id}]`);
    let roomName; // Will be set on 'join'

    socket.on('disconnect', () => {
      console.log(`Client disconnected [socketId:${socket.id}]`);
      if (!roomName) return;
      cleanupPeer(roomName, socket.id);
    });

    // Client requests to join a room
    socket.on('join', async ({ room }, callback) => {
      try {
        roomName = room; // Store roomName for this socket
        socket.join(roomName)
        const client_id = socket.handshake.query.client_id;
        const name = socket.handshake.query.name || 'Unknown';
        const isExaminer = socket.handshake.query.isExaminer === 'true';
        const { router, peers } = await getOrCreateRoom(roomName);

        // A new peer joins the room
        peers.set(socket.id, {
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
          client_id,
          name,
          isExaminer
        });

        // Get a list of existing producers in the room
        const existingProducerIds = [];
        for (const [peerSocketId, peer] of peers.entries()) {
            for (const producer of peer.producers.values()) {
                existingProducerIds.push({ producerId: producer.id, kind: producer.kind, peerId:  peerSocketId,  client_id:  peer.client_id, name: peer.name });
            }
        }

        callback({ 
          rtpCapabilities: router.rtpCapabilities,
          existingProducers: existingProducerIds,
        });

      } catch (e) {
        console.error('Error joining room:', e);
        callback({ error: e.message });
      }
    });

    // Client requests to create a transport
    socket.on('create-transport', async ({ direction }, callback) => {
      try {
        const { router, peers } = rooms.get(roomName);
        const transport = await createWebRtcTransport(router);
        peers.get(socket.id).transports.set(transport.id, transport);

        // When a transport is closed, notify the client
        transport.on('dtlsstatechange', (dtlsState) => {
            if (dtlsState === 'closed') {
                console.log(`Transport closed for peer [socketId:${socket.id}]`)
                transport.close();
            }
        });

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (e) {
        console.error('Error creating transport:', e);
        callback({ error: e.message });
      }
    });

    // Client connects a transport
    socket.on('connect-transport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        const transport = rooms.get(roomName).peers.get(socket.id).transports.get(transportId);
        if (!transport) throw new Error(`Transport not found: ${transportId}`);
        await transport.connect({ dtlsParameters });
        callback({ success: true });
      } catch (e) {
        console.error('Error connecting transport:', e);
        callback({ error: e.message });
      }
    });

    // Client starts producing
    socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
      try {
        const room = rooms.get(roomName);
        const transport = room.peers.get(socket.id).transports.get(transportId);
        if (!transport) throw new Error(`Transport not found: ${transportId}`);

        const producer = await transport.produce({ kind, rtpParameters });
        room.peers.get(socket.id).producers.set(producer.id, producer);

        // When a producer is closed (e.g., user stops sharing), clean up
        producer.on('transportclose', () => {
            console.log(`Producer's transport closed, cleaning up [producerId:${producer.id}]`);
            
            // Find the peer that owns this producer.
            let peerToClean = null;
            for (const peer of rooms.get(roomName)?.peers.values() || []) {
                if (peer.producers.has(producer.id)) {
                    peerToClean = peer;
                    break;
                }
            }
            
            // If found, remove the producer from that peer's map.
            if (peerToClean) {
                peerToClean.producers.delete(producer.id);
            }
            
            // Finally, notify everyone in the room that this producer is gone.
            io.to(roomName).emit('producer-closed', { producerId: producer.id });
        });

        // Inform everyone else in the room about the new producer
        socket.to(roomName).emit('new-producer', { producerId: producer.id, kind: producer.kind, peerId: socket.id, client_id:  room.peers.get(socket.id).client_id, name:  room.peers.get(socket.id).name, isExaminer: room.peers.get(socket.id).isExaminer });
        callback({ id: producer.id });

      } catch (e) {
        console.error('Error producing:', e);
        callback({ error: e.message });
      }
    });

    // Client requests to consume a producer
    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
        try {
            const room = rooms.get(roomName);
            const { router } = room;

            if (!router.canConsume({ producerId, rtpCapabilities })) {
                throw new Error(`Client cannot consume [producerId:${producerId}]`);
            }

            const transport = room.peers.get(socket.id).transports.get(transportId);
            if (!transport) throw new Error(`Transport not found: ${transportId}`);

            const consumer = await transport.consume({
                producerId,
                rtpCapabilities,
                paused: true, // Start paused, client will resume
            });

            room.peers.get(socket.id).consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => {
                console.log(`Consumer's transport closed [consumerId:${consumer.id}]`);
                // No need to do anything special here, transport closure handles it.
            });
            consumer.on('producerclose', () => {
                console.log(`Associated producer closed [consumerId:${consumer.id}]`);
                socket.emit('consumer-closed', { consumerId: consumer.id });
                room.peers.get(socket.id).consumers.delete(consumer.id);
            });

            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });

        } catch (e) {
            console.error('Error consuming:', e);
            callback({ error: e.message });
        }
    });

    // Client requests to resume a consumer
    socket.on('resume-consumer', async ({ consumerId }, callback) => {
        try {
            const consumer = rooms.get(roomName).peers.get(socket.id).consumers.get(consumerId);
            if (!consumer) throw new Error(`Consumer not found: ${consumerId}`);
            await consumer.resume();
            callback({ success: true });
        } catch (e) {
            console.error('Error resuming consumer:', e);
            callback({ error: e.message });
        }
    });

    socket.on('private-message', ({ toClientId, message }) => {
      if (!roomName) return;

      const room = rooms.get(roomName);
      if (!room) return;

      const senderPeer = room.peers.get(socket.id);
      if (!senderPeer) return;

      const toSocketEntry = Array.from(room.peers.entries()).find(
        ([, peer]) => peer.client_id === toClientId
      );

      if (toSocketEntry) {
        const [toSocketId] = toSocketEntry;
        io.to(toSocketId).emit('private-message', {
          fromClientId: senderPeer.client_id,
          fromName: senderPeer.name,
          message
        });
      }
    });

    // Exam Violation Detection Event
    socket.on('exam-violation-detected', ({ toClientId, violationDetails }) => {
      if (!roomName) return;

      const room = rooms.get(roomName);
      if (!room) return;

      const senderPeer = room.peers.get(socket.id);
      if (!senderPeer) return;

     
        io.to(toSocketId).emit('exam-violation-detected', {
          fromClientId: senderPeer.client_id,
          fromName: senderPeer.name,
          violationDetails
        });
    });
  });

  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

/**
 * --- Helper Functions ---
 */
async function createWorkers() {
  const numWorkers = os.cpus().length;
  console.log(`Creating ${numWorkers} mediasoup workers...`);
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });
    worker.on('died', () => {
      console.error(`mediasoup worker ${worker.pid} has died, exiting in 2 seconds...`);
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
  }
}

function getNextWorker() {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

async function getOrCreateRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    const worker = getNextWorker();
    const router = await worker.createRouter({
      mediaCodecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
        // { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
      ],
    });
    room = { router, peers: new Map() };
    rooms.set(roomName, room);
    console.log(`Room created [roomName:${roomName}]`);
  }
  return room;
}

// ------------------- WITH THIS NEW, SIMPLIFIED FUNCTION -------------------
function cleanupPeer(roomName, socketId) {
    const room = rooms.get(roomName);
    if (!room) return;

    const peer = room.peers.get(socketId);
    if (!peer) return;

    console.log(`Cleaning up peer [socketId:${socketId}]`);

    // Closing the transports will trigger the 'transportclose' event on any
    // associated producers, which will handle the rest of the cleanup.
    for (const transport of peer.transports.values()) {
        transport.close();
    }

    room.peers.delete(socketId);

    // If the room is empty, close the router to free up all resources
    if (room.peers.size === 0) {
        console.log(`Room is empty, closing router [roomName:${roomName}]`);
        room.router.close();
        rooms.delete(roomName);
    }
}
async function createWebRtcTransport(router) {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
  });
}

// Start the server
run();